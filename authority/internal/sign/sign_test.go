package sign

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

var update = flag.Bool("update", false, "rewrite testdata/statement-signature.json with a fresh key")

var vectorPath = filepath.Join("..", "..", "testdata", "statement-signature.json")

// fakeKMS signs with a local key the way KMS signs with its own.
type fakeKMS struct {
	key         *ecdsa.PrivateKey
	signWith    *ecdsa.PrivateKey
	spec        types.KeySpec
	failLookups int
	signs       []*kms.SignInput
	lookups     int
}

func newFake(t *testing.T) *fakeKMS {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeKMS{key: key, signWith: key, spec: types.KeySpecEccNistP256}
}

func (f *fakeKMS) Sign(_ context.Context, in *kms.SignInput, _ ...func(*kms.Options)) (*kms.SignOutput, error) {
	f.signs = append(f.signs, in)
	digest := sha256.Sum256(in.Message)
	sig, err := ecdsa.SignASN1(rand.Reader, f.signWith, digest[:])
	return &kms.SignOutput{Signature: sig}, err
}

func (f *fakeKMS) GetPublicKey(_ context.Context, _ *kms.GetPublicKeyInput, _ ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error) {
	f.lookups++
	if f.failLookups > 0 {
		f.failLookups--
		return nil, errors.New("throttled")
	}
	spki, err := x509.MarshalPKIXPublicKey(&f.key.PublicKey)
	return &kms.GetPublicKeyOutput{PublicKey: spki, KeySpec: f.spec, KeyUsage: types.KeyUsageTypeSignVerify}, err
}

func TestSignsRawECDSAP256WithTheNamedKey(t *testing.T) {
	fake := newFake(t)
	signer := NewKMS(fake, "alias/lnurl-authority")
	payload := []byte("a statement")
	sig, err := signer.Sign(context.Background(), payload)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	if !ecdsa.VerifyASN1(&fake.key.PublicKey, digest[:], sig) {
		t.Fatal("the signature does not verify")
	}
	in := fake.signs[0]
	if aws.ToString(in.KeyId) != "alias/lnurl-authority" || in.MessageType != types.MessageTypeRaw || in.SigningAlgorithm != types.SigningAlgorithmSpecEcdsaSha256 {
		t.Fatalf("asked KMS for %+v", in)
	}
}

func TestRefusesAPayloadKMSCannotSignRaw(t *testing.T) {
	fake := newFake(t)
	if _, err := NewKMS(fake, "k").Sign(context.Background(), make([]byte, MaxPayload+1)); err == nil || len(fake.signs) != 0 {
		t.Fatalf("got %v after %d KMS calls", err, len(fake.signs))
	}
}

func TestRefusesAKeyThatIsNotP256ForSigning(t *testing.T) {
	fake := newFake(t)
	fake.spec = types.KeySpecEccNistP384
	if _, err := NewKMS(fake, "k").PublicKey(context.Background()); err == nil {
		t.Fatal("accepted a P-384 key")
	}
}

func TestRefusesASignatureThePublishedKeyDidNotMake(t *testing.T) {
	fake := newFake(t)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	fake.signWith = other
	if _, err := NewKMS(fake, "k").Sign(context.Background(), []byte("a statement")); err == nil {
		t.Fatal("returned a signature its published key cannot verify")
	}
}

func TestCachesThePublicKeyOnlyOnceItHasIt(t *testing.T) {
	fake := newFake(t)
	fake.failLookups = 1
	signer := NewKMS(fake, "k")
	if _, err := signer.PublicKey(context.Background()); err == nil {
		t.Fatal("a failed lookup returned a key")
	}
	for range 2 {
		if _, err := signer.PublicKey(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if fake.lookups != 2 {
		t.Fatalf("%d lookups, want 2: one failed, one cached", fake.lookups)
	}
}

type statementVector struct {
	SPKI      string `json:"spki"`
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// The TypeScript client verifies this same statement, which is what holds the two
// languages to one signature encoding.
func TestStatementSignatureVector(t *testing.T) {
	if *update {
		fake := newFake(t)
		signer := NewKMS(fake, "k")
		spki, err := signer.PublicKey(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		operation := "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
		payload, err := wire.EncodeStatement(wire.Statement{
			AuthorityKeyID: KeyID(spki), Deployment: "lnurl-prod", CallerNonce: bytes.Repeat([]byte{0x5f}, 16),
			IssuedAtUnixMs: 1_790_000_000_000, ActiveEpoch: 3, ActiveWriterPublicKey: bytes.Repeat([]byte{0xe7}, 32),
			ReleasePolicyVersion: 2, Sequence: 0, CurrentOperationID: &operation,
		})
		if err != nil {
			t.Fatal(err)
		}
		sig, err := signer.Sign(context.Background(), payload)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := json.MarshalIndent(statementVector{
			SPKI: base64.StdEncoding.EncodeToString(spki), KeyID: KeyID(spki),
			Payload: hex.EncodeToString(payload), Signature: hex.EncodeToString(sig),
		}, "", "  ")
		if err := os.WriteFile(vectorPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	data, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatal(err)
	}
	var v statementVector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	spki, _ := base64.StdEncoding.DecodeString(v.SPKI)
	payload, _ := hex.DecodeString(v.Payload)
	sig, _ := hex.DecodeString(v.Signature)
	parsed, err := x509.ParsePKIXPublicKey(spki)
	key, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok {
		t.Fatalf("vector key: %v", err)
	}
	digest := sha256.Sum256(payload)
	if !ecdsa.VerifyASN1(key, digest[:], sig) || KeyID(spki) != v.KeyID {
		t.Fatal("the committed statement vector does not verify")
	}
	if _, err := wire.DecodeStatement(payload); err != nil {
		t.Fatalf("the vector's payload is not a statement: %v", err)
	}
}

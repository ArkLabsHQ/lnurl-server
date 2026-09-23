package attest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/hf/nitrite"
)

var at = time.UnixMilli(1_790_000_000_000)

func fill(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

type signer struct {
	key  *ecdsa.PrivateKey
	cert *x509.Certificate
	der  []byte
}

// certificate issues a P-384 certificate from parent, or a self-signed root when parent is nil.
func certificate(t *testing.T, subject string, parent *signer) *signer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: subject},
		NotBefore: at.Add(-time.Hour), NotAfter: at.Add(time.Hour), SignatureAlgorithm: x509.ECDSAWithSHA384,
		BasicConstraintsValid: true, IsCA: parent == nil, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
	}
	issuer, issuerKey := tmpl, key
	if parent != nil {
		issuer, issuerKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, issuer, &key.PublicKey, issuerKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &signer{key, cert, der}
}

type document struct {
	nonce, userData []byte
	pcrs            map[uint][]byte
	timestamp       time.Time
}

func good() document {
	return document{
		nonce: []byte("challenge-nonce-0020"), userData: fill(0x5d, 32),
		pcrs:      map[uint][]byte{0: fill(0x01, 48), 1: fill(0x02, 48), 2: fill(0x03, 48)},
		timestamp: at,
	}
}

// mint signs a COSE Sign1 attestation document the way the Nitro Security Module does.
func mint(t *testing.T, d document, leaf *signer, bundle ...*signer) []byte {
	t.Helper()
	var cab [][]byte
	for _, b := range bundle {
		cab = append(cab, b.der)
	}
	payload, err := cbor.Marshal(&nitrite.Document{
		ModuleID: "i-test-enc", Timestamp: uint64(d.timestamp.UnixMilli()), Digest: "SHA384",
		PCRs: d.pcrs, Certificate: leaf.der, CABundle: cab, Nonce: d.nonce, UserData: d.userData,
	})
	if err != nil {
		t.Fatal(err)
	}
	protected, _ := cbor.Marshal(map[int]int64{1: -35})
	toSign, _ := cbor.Marshal(&struct {
		_           struct{} `cbor:",toarray"`
		Context     string
		Protected   []byte
		ExternalAAD []byte
		Payload     []byte
	}{Context: "Signature1", Protected: protected, ExternalAAD: []byte{}, Payload: payload})
	digest := sha512.Sum384(toSign)
	r, s, err := ecdsa.Sign(rand.Reader, leaf.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := make([]byte, 96)
	r.FillBytes(signature[:48])
	s.FillBytes(signature[48:])
	envelope, err := cbor.Marshal(&struct {
		_           struct{} `cbor:",toarray"`
		Protected   []byte
		Unprotected cbor.RawMessage
		Payload     []byte
		Signature   []byte
	}{Protected: protected, Unprotected: cbor.RawMessage{0xa0}, Payload: payload, Signature: signature})
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

func pool(roots ...*signer) *x509.CertPool {
	p := x509.NewCertPool()
	for _, r := range roots {
		p.AddCert(r.cert)
	}
	return p
}

func TestAcceptsAGenuineAWSDocumentAtItsOwnTime(t *testing.T) {
	b64, err := os.ReadFile(filepath.Join("..", "..", "testdata", "nitro-attestation.b64"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b64)))
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := nitrite.Verify(doc, nitrite.VerifyOptions{})
	if parsed == nil {
		t.Fatal("the fixture does not parse")
	}
	d := parsed.Document
	v := &Verifier{now: func() time.Time { return time.UnixMilli(int64(d.Timestamp)) }}
	pcrs, err := v.Verify(doc, d.Nonce, d.UserData)
	if err != nil {
		t.Fatalf("a genuine AWS document was refused: %v", err)
	}
	if pcrs[0] != hex.EncodeToString(d.PCRs[0]) {
		t.Fatalf("PCR0 read as %s", pcrs[0])
	}
	if _, err := v.Verify(doc, []byte("another challenge"), d.UserData); err == nil {
		t.Fatal("a genuine document was accepted for another challenge")
	}
}

func TestRefusesASelfSignedChainThatNitriteCallsSignatureOK(t *testing.T) {
	self := certificate(t, "untrusted.test", nil)
	d := good()
	doc := mint(t, d, self, self)
	if res, err := nitrite.Verify(doc, nitrite.VerifyOptions{CurrentTime: at}); err == nil || res == nil || !res.SignatureOK {
		t.Fatalf("nitrite no longer pairs SignatureOK with an untrusted chain (err %v); revisit the gate", err)
	}
	v := &Verifier{now: func() time.Time { return at }}
	if _, err := v.Verify(doc, d.nonce, d.userData); err == nil {
		t.Fatal("a self-signed document was accepted")
	}
}

func TestBindsTheChallengePayloadTimeAndMeasurements(t *testing.T) {
	root := certificate(t, "test root", nil)
	leaf := certificate(t, "test enclave", root)
	v := &Verifier{roots: pool(root), now: func() time.Time { return at }}
	want := good()

	pcrs, err := v.Verify(mint(t, want, leaf, root), want.nonce, want.userData)
	if err != nil {
		t.Fatalf("a document under the test root was refused: %v", err)
	}
	if pcrs != [3]string{hex.EncodeToString(fill(1, 48)), hex.EncodeToString(fill(2, 48)), hex.EncodeToString(fill(3, 48))} {
		t.Fatalf("PCRs read as %v", pcrs)
	}

	for name, mutate := range map[string]func(*document){
		"another nonce":      func(d *document) { d.nonce = []byte("another-challenge-00") },
		"another payload":    func(d *document) { d.userData = fill(0x5e, 32) },
		"extended user data": func(d *document) { d.userData = append([]byte("sha256:"), d.userData...) },
		"ten minutes stale":  func(d *document) { d.timestamp = at.Add(-10 * time.Minute) },
		"from the future":    func(d *document) { d.timestamp = at.Add(10 * time.Minute) },
		"no PCR2":            func(d *document) { delete(d.pcrs, 2) },
		"debug PCR1":         func(d *document) { d.pcrs[1] = make([]byte, 48) },
		"SHA-256 PCR0":       func(d *document) { d.pcrs[0] = fill(0x01, 32) },
	} {
		d := good()
		mutate(&d)
		if _, err := v.Verify(mint(t, d, leaf, root), want.nonce, want.userData); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	tampered := mint(t, want, leaf, root)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := v.Verify(tampered, want.nonce, want.userData); err == nil {
		t.Error("a tampered signature was accepted")
	}
	otherRoot := certificate(t, "other root", nil)
	if _, err := v.Verify(mint(t, want, certificate(t, "stranger", otherRoot), otherRoot), want.nonce, want.userData); err == nil {
		t.Error("a document from another root was accepted")
	}
}

func TestProductionVerifierTrustsOnlyAWSAndTheWallClock(t *testing.T) {
	v := New()
	if v.roots != nil {
		t.Fatal("New installed a root pool")
	}
	if reflect.ValueOf(v.now).Pointer() != reflect.ValueOf(time.Now).Pointer() {
		t.Fatal("New does not read the wall clock")
	}
}

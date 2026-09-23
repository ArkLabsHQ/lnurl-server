// Package sign holds the authority's statement key. In production the key never
// leaves KMS; the only local key is in this package's tests.
package sign

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// MaxPayload is the most KMS will sign as a raw message.
const MaxPayload = 4096

// Signer signs statements with ECDSA P-256 over SHA-256 and returns a DER signature.
type Signer interface {
	PublicKey(ctx context.Context) ([]byte, error)
	Sign(ctx context.Context, payload []byte) ([]byte, error)
}

// KeyID names a statement key by the SHA-256 of its SPKI encoding, so an enclave can
// derive the ids of the keys it pins instead of being told them.
func KeyID(spki []byte) string {
	sum := sha256.Sum256(spki)
	return hex.EncodeToString(sum[:])
}

type KMSClient interface {
	Sign(ctx context.Context, in *kms.SignInput, opts ...func(*kms.Options)) (*kms.SignOutput, error)
	GetPublicKey(ctx context.Context, in *kms.GetPublicKeyInput, opts ...func(*kms.Options)) (*kms.GetPublicKeyOutput, error)
}

type KMS struct {
	client KMSClient
	keyID  string
	mu     sync.Mutex
	spki   []byte
	key    *ecdsa.PublicKey
}

func NewKMS(client KMSClient, keyID string) *KMS { return &KMS{client: client, keyID: keyID} }

func (k *KMS) PublicKey(ctx context.Context) ([]byte, error) {
	if _, err := k.verifier(ctx); err != nil {
		return nil, err
	}
	return k.spki, nil
}

func (k *KMS) verifier(ctx context.Context) (*ecdsa.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.key != nil {
		return k.key, nil
	}
	out, err := k.client.GetPublicKey(ctx, &kms.GetPublicKeyInput{KeyId: aws.String(k.keyID)})
	if err != nil {
		return nil, fmt.Errorf("kms: %w", err)
	}
	if out.KeySpec != types.KeySpecEccNistP256 || out.KeyUsage != types.KeyUsageTypeSignVerify {
		return nil, fmt.Errorf("kms: key %s is %s for %s, want %s for %s", k.keyID, out.KeySpec, out.KeyUsage, types.KeySpecEccNistP256, types.KeyUsageTypeSignVerify)
	}
	parsed, err := x509.ParsePKIXPublicKey(out.PublicKey)
	key, ok := parsed.(*ecdsa.PublicKey)
	if err != nil || !ok {
		return nil, fmt.Errorf("kms: key %s has an unreadable public key", k.keyID)
	}
	k.spki, k.key = out.PublicKey, key
	return key, nil
}

func (k *KMS) Sign(ctx context.Context, payload []byte) ([]byte, error) {
	if len(payload) > MaxPayload {
		return nil, fmt.Errorf("kms: a %d-byte payload is over the %d bytes KMS signs raw", len(payload), MaxPayload)
	}
	key, err := k.verifier(ctx)
	if err != nil {
		return nil, err
	}
	out, err := k.client.Sign(ctx, &kms.SignInput{
		KeyId: aws.String(k.keyID), Message: payload,
		MessageType: types.MessageTypeRaw, SigningAlgorithm: types.SigningAlgorithmSpecEcdsaSha256,
	})
	if err != nil {
		return nil, fmt.Errorf("kms: %w", err)
	}
	// A key id mapped to the wrong key would otherwise surface only as every enclave
	// refusing every statement.
	digest := sha256.Sum256(payload)
	if !ecdsa.VerifyASN1(key, digest[:], out.Signature) {
		return nil, errors.New("kms: the signature does not verify under the published key")
	}
	return out.Signature, nil
}

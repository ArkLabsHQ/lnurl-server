// Package attest verifies the Nitro attestation a candidate writer presents. It has no
// insecure mode: New trusts only nitrite's embedded AWS root and the wall clock, and
// nothing outside this package can change either.
package attest

import (
	"bytes"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/hf/nitrite"
)

// MaxSkew bounds how far a document's own timestamp may sit from the authority's clock.
const MaxSkew = 5 * time.Minute

type Verifier struct {
	roots *x509.CertPool
	now   func() time.Time
}

func New() *Verifier { return &Verifier{now: time.Now} }

// Verify implements state.QuoteVerifier.
func (v *Verifier) Verify(document, nonce, userData []byte) ([3]string, error) {
	now := v.now()
	res, err := nitrite.Verify(document, nitrite.VerifyOptions{Roots: v.roots, CurrentTime: now})
	// The error is the only verdict. nitrite also reports SignatureOK, and it is true
	// for a self-signed chain anyone can mint, returned alongside that error.
	if err != nil {
		return [3]string{}, fmt.Errorf("attestation: %w", err)
	}
	doc := res.Document
	if skew := now.Sub(time.UnixMilli(int64(doc.Timestamp))); skew > MaxSkew || skew < -MaxSkew {
		return [3]string{}, fmt.Errorf("attestation: timestamped %s away from now", skew)
	}
	if !bytes.Equal(doc.Nonce, nonce) {
		return [3]string{}, errors.New("attestation: nonce is not the challenge's")
	}
	if !bytes.Equal(doc.UserData, userData) {
		return [3]string{}, errors.New("attestation: user data does not bind this payload")
	}
	var pcrs [3]string
	for i := range pcrs {
		p, ok := doc.PCRs[uint(i)]
		if !ok || len(p) != 48 {
			return [3]string{}, fmt.Errorf("attestation: PCR%d missing or not SHA-384", i)
		}
		if bytes.Equal(p, make([]byte, 48)) {
			return [3]string{}, fmt.Errorf("attestation: PCR%d is zero, as in a debug enclave", i)
		}
		pcrs[i] = hex.EncodeToString(p)
	}
	return pcrs, nil
}

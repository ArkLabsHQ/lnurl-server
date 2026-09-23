// Package adopt reads the HEAD.json an enclave wrote before any authority existed, so
// the operator can make it a deployment's first committed checkpoint. Adopting one is
// the operator asserting it is the true current head, the assertion
// ENCLAVE_CHECKPOINT_HEAD makes, made once and in the security account.
package adopt

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// v2Head is src/enclave/checkpoint.ts's CheckpointHead as that code writes it.
type v2Head struct {
	Schema           string  `json:"schema"`
	Prefix           string  `json:"prefix"`
	Sequence         uint64  `json:"sequence"`
	Digest           string  `json:"digest"`
	Size             uint64  `json:"size"`
	CiphertextDigest string  `json:"ciphertextDigest"`
	Key              string  `json:"key"`
	SchemaVersion    uint32  `json:"schemaVersion"`
	Epoch            uint64  `json:"epoch"`
	PreviousDigest   *string `json:"previousDigest"`
}

// Head parses a pre-authority HEAD.json for prefix. A file written under an authority
// carries "authoritative": false and is refused: it is a hint, not a chain to adopt.
func Head(data []byte, prefix string) (wire.Head, error) {
	var h v2Head
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return wire.Head{}, fmt.Errorf("adopt: not a pre-authority HEAD.json: %w", err)
	}
	switch {
	case h.Schema != state.HeadSchema:
		return wire.Head{}, fmt.Errorf("adopt: schema %q, want %q", h.Schema, state.HeadSchema)
	case h.Prefix != prefix:
		return wire.Head{}, fmt.Errorf("adopt: prefix %q is not %q", h.Prefix, prefix)
	case h.Sequence < 1 || h.Size < 1:
		return wire.Head{}, fmt.Errorf("adopt: sequence and size must be positive")
	case !hex64.MatchString(h.Digest) || !hex64.MatchString(h.CiphertextDigest) || h.PreviousDigest != nil && !hex64.MatchString(*h.PreviousDigest):
		return wire.Head{}, fmt.Errorf("adopt: digests must be 64 lowercase hex characters")
	}
	head := wire.Head{
		Schema: h.Schema, Prefix: h.Prefix, SchemaVersion: h.SchemaVersion, SealEpoch: h.Epoch, Sequence: h.Sequence,
		PreviousDigest: h.PreviousDigest, Digest: h.Digest, Size: h.Size, CiphertextDigest: h.CiphertextDigest, Key: h.Key,
	}
	// The wire encoding checks what remains: bounds, and a key naming its own object.
	if _, err := wire.EncodeStatement(wire.Statement{Head: &head}); err != nil {
		return wire.Head{}, fmt.Errorf("adopt: %w", err)
	}
	return head, nil
}

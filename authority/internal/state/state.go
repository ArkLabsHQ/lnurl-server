// Package state holds the checkpoint authority's transition rules: which enclave may
// become the writer, and which checkpoint a writer may commit.
package state

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

const HeadSchema = "lnurl.enclave.checkpoint.v2"

var (
	ErrNotFound           = errors.New("unknown deployment")
	ErrExists             = errors.New("deployment already exists")
	ErrMalformed          = errors.New("malformed request")
	ErrChallenge          = errors.New("challenge missing, expired or replaced")
	ErrQuote              = errors.New("attestation refused")
	ErrNotApproved        = errors.New("measurement not approved for this deployment")
	ErrPolicyDowngrade    = errors.New("release policy would move backwards")
	ErrProof              = errors.New("proof of possession refused")
	ErrSignature          = errors.New("writer signature refused")
	ErrHead               = errors.New("checkpoint refused")
	ErrWriterFenced       = errors.New("writer fenced by a successor")
	ErrCheckpointConflict = errors.New("checkpoint conflict")
	ErrOperationReused    = errors.New("operation id reused with different parameters")
)

// Conflict is a refusal only the authority's current state can resolve, so it carries it.
type Conflict struct {
	Err     error
	Current *Record
}

func (c *Conflict) Error() string { return c.Err.Error() }
func (c *Conflict) Unwrap() error { return c.Err }

// ConditionFailed is a Store's answer when a conditional write's condition did not
// hold, with the record as it stood.
type ConditionFailed struct{ Current *Record }

func (c *ConditionFailed) Error() string { return "condition failed" }

type Challenge struct {
	ID          string
	Nonce       []byte
	ExpiresAtMs uint64
}

type Writer struct {
	PublicKey     []byte
	PCRs          [3]string
	ActivatedAtMs uint64
	QuoteSHA256   string
}

// Record is the one bounded item a deployment has. Nothing in it accumulates.
type Record struct {
	Deployment           string
	Prefix               string
	Epoch                uint64
	Writer               *Writer
	ReleasePolicyVersion uint32
	Sequence             uint64
	Checkpoint           *wire.Head
	CurrentOperationID   string
	PendingChallenge     *Challenge
	RecordVersion        uint64
	UpdatedAtMs          uint64
}

// Activation installs a writer. It holds only if, atomically: the epoch is
// ExpectedEpoch; the pending challenge is ChallengeID and unexpired at NowMs; the
// release policy does not move backwards; and the record's checkpoint is exactly
// Restored (by ciphertext digest and sequence), or absent at sequence 0 when Restored
// is nil. It sets the epoch to ExpectedEpoch+1, which is what fences the predecessor.
type Activation struct {
	Deployment           string
	ExpectedEpoch        uint64
	ChallengeID          string
	NowMs                uint64
	ReleasePolicyVersion uint32
	Restored             *wire.Head
	Writer               Writer
}

// CommitUpdate advances the checkpoint. It holds only if, atomically: the epoch is
// Epoch and the writer key is WriterPublicKey; the sequence is ExpectedSequence; the
// committed checkpoint's ciphertext digest is PriorDigest, or there is none when
// PriorDigest is nil; and OperationID is not the current operation.
type CommitUpdate struct {
	Deployment       string
	Epoch            uint64
	WriterPublicKey  []byte
	ExpectedSequence uint64
	PriorDigest      *string
	Head             wire.Head
	OperationID      string
	NowMs            uint64
}

// Store keeps deployment records. On a failed condition, Activate and Commit return
// *ConditionFailed carrying the record as it stood, and write nothing.
type Store interface {
	Get(ctx context.Context, deployment string) (*Record, error)
	Create(ctx context.Context, r Record) error
	PutChallenge(ctx context.Context, deployment string, c Challenge, nowMs uint64) error
	Activate(ctx context.Context, a Activation) (*Record, error)
	Commit(ctx context.Context, c CommitUpdate) (*Record, error)
}

type QuoteVerifier interface {
	// Verify accepts only a genuine attestation carrying exactly this nonce and user
	// data, and returns its PCR0, PCR1 and PCR2 as lowercase hex.
	Verify(document, nonce, userData []byte) ([3]string, error)
}

type Approvals interface {
	// Approved returns the release-policy version under which these measurements may
	// write for the deployment, or false if they may not.
	Approved(ctx context.Context, deployment string, pcrs [3]string) (uint32, bool, error)
}

type Authority struct {
	Store        Store
	Quotes       QuoteVerifier
	Approvals    Approvals
	Now          func() time.Time
	ChallengeTTL time.Duration
}

func (a *Authority) nowMs() uint64 { return uint64(a.Now().UnixMilli()) }

func (a *Authority) State(ctx context.Context, deployment string) (*Record, error) {
	return a.Store.Get(ctx, deployment)
}

func (a *Authority) Challenge(ctx context.Context, deployment string) (Challenge, error) {
	now := a.nowMs()
	c := Challenge{ID: hex.EncodeToString(random(16)), Nonce: random(20), ExpiresAtMs: now + uint64(a.ChallengeTTL.Milliseconds())}
	if err := a.Store.PutChallenge(ctx, deployment, c, now); err != nil {
		return Challenge{}, err
	}
	return c, nil
}

type ActivateRequest struct {
	Payload             []byte
	AttestationDocument []byte
	ProofOfPossession   []byte
}

func (a *Authority) Activate(ctx context.Context, req ActivateRequest) (*Record, error) {
	m, err := wire.DecodeActivate(req.Payload)
	if err != nil || len(m.WriterPublicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: activation payload", ErrMalformed)
	}
	rec, err := a.Store.Get(ctx, m.Deployment)
	if err != nil {
		return nil, err
	}
	now := a.nowMs()
	if c := rec.PendingChallenge; c == nil || c.ID != m.ChallengeID || !bytes.Equal(c.Nonce, m.ChallengeNonce) || c.ExpiresAtMs <= now {
		return nil, ErrChallenge
	}
	userData := sha256.Sum256(req.Payload)
	pcrs, err := a.Quotes.Verify(req.AttestationDocument, m.ChallengeNonce, userData[:])
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrQuote, err)
	}
	policy, ok, err := a.Approvals.Approved(ctx, m.Deployment, pcrs)
	if err != nil {
		return nil, err
	}
	if !ok || policy != m.ReleasePolicyVersion {
		return nil, ErrNotApproved
	}
	if policy < rec.ReleasePolicyVersion {
		return nil, ErrPolicyDowngrade
	}
	if !ed25519.Verify(ed25519.PublicKey(m.WriterPublicKey), req.Payload, req.ProofOfPossession) {
		return nil, ErrProof
	}
	if m.Restored != nil && m.Restored.Prefix != rec.Prefix {
		return nil, fmt.Errorf("%w: prefix %q is not this deployment's", ErrHead, m.Restored.Prefix)
	}
	quote := sha256.Sum256(req.AttestationDocument)
	updated, err := a.Store.Activate(ctx, Activation{
		Deployment: m.Deployment, ExpectedEpoch: rec.Epoch, ChallengeID: m.ChallengeID, NowMs: now,
		ReleasePolicyVersion: policy, Restored: m.Restored,
		Writer: Writer{PublicKey: m.WriterPublicKey, PCRs: pcrs, ActivatedAtMs: now, QuoteSHA256: hex.EncodeToString(quote[:])},
	})
	var failed *ConditionFailed
	if errors.As(err, &failed) {
		if !isCheckpoint(failed.Current, m.Restored) {
			return nil, &Conflict{Err: ErrCheckpointConflict, Current: failed.Current}
		}
		return nil, &Conflict{Err: ErrChallenge, Current: failed.Current}
	}
	return updated, err
}

type CommitRequest struct {
	Payload   []byte
	Signature []byte
}

func (a *Authority) Commit(ctx context.Context, req CommitRequest) (*Record, error) {
	m, err := wire.DecodeCommit(req.Payload)
	if err != nil {
		return nil, fmt.Errorf("%w: commit payload", ErrMalformed)
	}
	rec, err := a.Store.Get(ctx, m.Deployment)
	if err != nil {
		return nil, err
	}
	// A fenced writer's key is no longer on record, so its signature cannot be
	// checked; it gets only the public state, and nothing is written.
	if rec.Writer == nil || rec.Epoch != m.Epoch {
		return settle(rec, m)
	}
	if !ed25519.Verify(rec.Writer.PublicKey, req.Payload, req.Signature) {
		return nil, ErrSignature
	}
	if err := checkHead(rec, m); err != nil {
		return nil, err
	}
	updated, err := a.Store.Commit(ctx, CommitUpdate{
		Deployment: m.Deployment, Epoch: m.Epoch, WriterPublicKey: rec.Writer.PublicKey,
		ExpectedSequence: m.ExpectedSequence, PriorDigest: m.PriorDigest, Head: m.Head,
		OperationID: m.OperationID, NowMs: a.nowMs(),
	})
	var failed *ConditionFailed
	if errors.As(err, &failed) {
		return settle(failed.Current, m)
	}
	return updated, err
}

// settle answers a commit whose conditions do not hold, from the record as it stands.
func settle(cur *Record, m wire.Commit) (*Record, error) {
	switch {
	case cur.CurrentOperationID == m.OperationID && isCheckpoint(cur, &m.Head):
		return cur, nil
	case cur.CurrentOperationID == m.OperationID:
		return nil, &Conflict{Err: ErrOperationReused, Current: cur}
	case cur.Writer == nil || cur.Epoch != m.Epoch:
		return nil, &Conflict{Err: ErrWriterFenced, Current: cur}
	default:
		return nil, &Conflict{Err: ErrCheckpointConflict, Current: cur}
	}
}

func checkHead(rec *Record, m wire.Commit) error {
	h := m.Head
	switch {
	case h.Schema != HeadSchema:
		return fmt.Errorf("%w: unsupported schema %q", ErrHead, h.Schema)
	case h.Prefix != rec.Prefix:
		return fmt.Errorf("%w: prefix %q is not this deployment's", ErrHead, h.Prefix)
	case h.SealEpoch != m.Epoch:
		return fmt.Errorf("%w: sealed under epoch %d, committed under %d", ErrHead, h.SealEpoch, m.Epoch)
	case h.Sequence != m.ExpectedSequence+1:
		return fmt.Errorf("%w: sequence %d does not follow %d", ErrHead, h.Sequence, m.ExpectedSequence)
	case (m.PriorDigest == nil) != (m.ExpectedSequence == 0):
		return fmt.Errorf("%w: a prior digest is required after the first checkpoint, and only then", ErrHead)
	case !sameDigest(h.PreviousDigest, m.PriorDigest):
		return fmt.Errorf("%w: its previous digest does not link to the prior checkpoint", ErrHead)
	case rec.Checkpoint != nil && h.SchemaVersion < rec.Checkpoint.SchemaVersion:
		return fmt.Errorf("%w: schema version %d is older than %d", ErrHead, h.SchemaVersion, rec.Checkpoint.SchemaVersion)
	}
	return nil
}

// isCheckpoint reports whether h is the record's committed checkpoint; a nil h means none.
func isCheckpoint(r *Record, h *wire.Head) bool {
	if h == nil || r.Checkpoint == nil {
		return h == nil && r.Checkpoint == nil && r.Sequence == 0
	}
	return r.Checkpoint.CiphertextDigest == h.CiphertextDigest && r.Sequence == h.Sequence
}

func sameDigest(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func random(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

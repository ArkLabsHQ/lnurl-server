// Package memory is a state.Store for tests and the local development server. A mutex
// stands in for DynamoDB's conditional writes.
package memory

import (
	"bytes"
	"context"
	"sync"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

type Store struct {
	mu      sync.Mutex
	records map[string]state.Record
}

func New() *Store { return &Store{records: map[string]state.Record{}} }

func (s *Store) Get(_ context.Context, deployment string) (*state.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[deployment]
	if !ok {
		return nil, state.ErrNotFound
	}
	return clone(r), nil
}

func (s *Store) Create(_ context.Context, r state.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[r.Deployment]; ok {
		return state.ErrExists
	}
	s.records[r.Deployment] = *clone(r)
	return nil
}

func (s *Store) PutChallenge(_ context.Context, deployment string, c state.Challenge, nowMs uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[deployment]
	if !ok {
		return state.ErrNotFound
	}
	c.Nonce = bytes.Clone(c.Nonce)
	r.PendingChallenge = &c
	r.RecordVersion++
	r.UpdatedAtMs = nowMs
	s.records[deployment] = r
	return nil
}

func (s *Store) Activate(_ context.Context, a state.Activation) (*state.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[a.Deployment]
	if !ok {
		return nil, state.ErrNotFound
	}
	c := r.PendingChallenge
	restored := a.Restored == nil && r.Checkpoint == nil && r.Sequence == 0 ||
		a.Restored != nil && r.Checkpoint != nil && r.Checkpoint.CiphertextDigest == a.Restored.CiphertextDigest && r.Sequence == a.Restored.Sequence
	if r.Epoch != a.ExpectedEpoch || c == nil || c.ID != a.ChallengeID || c.ExpiresAtMs <= a.NowMs ||
		r.ReleasePolicyVersion > a.ReleasePolicyVersion || !restored {
		return nil, &state.ConditionFailed{Current: clone(r)}
	}
	w := a.Writer
	w.PublicKey = bytes.Clone(w.PublicKey)
	r.Epoch = a.ExpectedEpoch + 1
	r.Writer = &w
	r.ReleasePolicyVersion = a.ReleasePolicyVersion
	r.PendingChallenge = nil
	r.RecordVersion++
	r.UpdatedAtMs = a.NowMs
	s.records[a.Deployment] = r
	return clone(r), nil
}

func (s *Store) Commit(_ context.Context, c state.CommitUpdate) (*state.Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.records[c.Deployment]
	if !ok {
		return nil, state.ErrNotFound
	}
	prior := c.PriorDigest == nil && r.Checkpoint == nil ||
		c.PriorDigest != nil && r.Checkpoint != nil && r.Checkpoint.CiphertextDigest == *c.PriorDigest
	if r.Epoch != c.Epoch || r.Writer == nil || !bytes.Equal(r.Writer.PublicKey, c.WriterPublicKey) ||
		r.Sequence != c.ExpectedSequence || !prior || r.CurrentOperationID == c.OperationID {
		return nil, &state.ConditionFailed{Current: clone(r)}
	}
	r.Checkpoint = cloneHead(&c.Head)
	r.Sequence = c.Head.Sequence
	r.CurrentOperationID = c.OperationID
	r.RecordVersion++
	r.UpdatedAtMs = c.NowMs
	s.records[c.Deployment] = r
	return clone(r), nil
}

func clone(r state.Record) *state.Record {
	if r.Writer != nil {
		w := *r.Writer
		w.PublicKey = bytes.Clone(w.PublicKey)
		r.Writer = &w
	}
	if r.PendingChallenge != nil {
		c := *r.PendingChallenge
		c.Nonce = bytes.Clone(c.Nonce)
		r.PendingChallenge = &c
	}
	r.Checkpoint = cloneHead(r.Checkpoint)
	return &r
}

func cloneHead(h *wire.Head) *wire.Head {
	if h == nil {
		return nil
	}
	c := *h
	if h.PreviousDigest != nil {
		p := *h.PreviousDigest
		c.PreviousDigest = &p
	}
	return &c
}

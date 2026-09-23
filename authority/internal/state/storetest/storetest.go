// Package storetest is the transition suite every state.Store must pass, so no store
// can drift from the rules the state machine states.
package storetest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

const deployment = "lnurl-test"

var (
	approvedPCRs = [3]string{strings.Repeat("01", 48), strings.Repeat("02", 48), strings.Repeat("03", 48)}
	newerPCRs    = [3]string{strings.Repeat("04", 48), strings.Repeat("02", 48), strings.Repeat("05", 48)}
	unknownPCRs  = [3]string{strings.Repeat("0e", 48), strings.Repeat("02", 48), strings.Repeat("0f", 48)}
)

// quote stands in for an attestation document; the fake verifier holds it to the
// same nonce and user-data binding the real one enforces.
type quote struct {
	Nonce    []byte
	UserData []byte
	PCRs     [3]string
}

type quotes struct{}

func (quotes) Verify(document, nonce, userData []byte) ([3]string, error) {
	var q quote
	if err := json.Unmarshal(document, &q); err != nil {
		return [3]string{}, err
	}
	if !bytes.Equal(q.Nonce, nonce) || !bytes.Equal(q.UserData, userData) {
		return [3]string{}, errors.New("quote binds another nonce or payload")
	}
	return q.PCRs, nil
}

type approvals map[[3]string]uint32

func (a approvals) Approved(_ context.Context, _ string, pcrs [3]string) (uint32, bool, error) {
	v, ok := a[pcrs]
	return v, ok, nil
}

type writer struct {
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newWriter(t *testing.T) writer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return writer{pub, priv}
}

type harness struct {
	t     *testing.T
	store state.Store
	auth  *state.Authority
	now   time.Time
}

func newHarness(t *testing.T, store state.Store, record state.Record) *harness {
	h := &harness{t: t, store: store, now: time.UnixMilli(1_790_000_000_000)}
	h.auth = &state.Authority{
		Store: store, Quotes: quotes{}, Approvals: approvals{approvedPCRs: 1, newerPCRs: 2},
		Now: func() time.Time { return h.now }, ChallengeTTL: time.Minute,
	}
	record.Deployment = deployment
	if record.Prefix == "" {
		record.Prefix = "lnurl/db"
	}
	if err := store.Create(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	return h
}

type activation struct {
	writer   writer
	restored *wire.Head
	pcrs     [3]string
	policy   uint32
	provedBy ed25519.PrivateKey
	quoted   []byte
	stale    *state.Challenge
}

func (h *harness) activate(a activation) (*state.Record, error) {
	h.t.Helper()
	ctx := context.Background()
	c, err := h.auth.Challenge(ctx, deployment)
	if err != nil {
		h.t.Fatal(err)
	}
	if a.stale != nil {
		c = *a.stale
	}
	if a.pcrs == ([3]string{}) {
		a.pcrs = approvedPCRs
	}
	if a.policy == 0 {
		a.policy = 1
	}
	payload, err := wire.EncodeActivate(wire.Activate{
		Deployment: deployment, ChallengeID: c.ID, ChallengeNonce: c.Nonce,
		WriterPublicKey: wire.Bytes(a.writer.pub), ReleasePolicyVersion: a.policy, Restored: a.restored,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	if a.quoted == nil {
		a.quoted = payload
	}
	if a.provedBy == nil {
		a.provedBy = a.writer.priv
	}
	userData := sha256.Sum256(a.quoted)
	document, _ := json.Marshal(quote{Nonce: c.Nonce, UserData: userData[:], PCRs: a.pcrs})
	return h.auth.Activate(ctx, state.ActivateRequest{
		Payload: payload, AttestationDocument: document, ProofOfPossession: ed25519.Sign(a.provedBy, payload),
	})
}

func (h *harness) commit(w writer, epoch, expected uint64, prior *string, head wire.Head, operation string) (*state.Record, error) {
	h.t.Helper()
	payload, err := wire.EncodeCommit(wire.Commit{
		Deployment: deployment, Epoch: epoch, OperationID: operation, ExpectedSequence: expected, PriorDigest: prior, Head: head,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return h.auth.Commit(context.Background(), state.CommitRequest{Payload: payload, Signature: ed25519.Sign(w.priv, payload)})
}

func (h *harness) record() *state.Record {
	h.t.Helper()
	r, err := h.store.Get(context.Background(), deployment)
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func digest(tag byte) string { return hex.EncodeToString(bytes.Repeat([]byte{tag}, 32)) }

func head(sequence, sealEpoch uint64, previous *string, tag byte) wire.Head {
	ciphertext := digest(tag)
	return wire.Head{
		Schema: state.HeadSchema, Prefix: "lnurl/db", SchemaVersion: 12, SealEpoch: sealEpoch, Sequence: sequence,
		PreviousDigest: previous, Digest: digest(tag ^ 0xff), Size: 4096,
		CiphertextDigest: ciphertext, Key: "lnurl/db/" + ciphertext + ".sqlite.br.enc",
	}
}

func ptr(s string) *string { return &s }

func operation(n byte) string { return hex.EncodeToString(bytes.Repeat([]byte{n}, 16)) }

func (h *harness) must(r *state.Record, err error) *state.Record {
	h.t.Helper()
	if err != nil {
		h.t.Fatal(err)
	}
	return r
}

func refused(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

// Run executes every case against a fresh store from open.
func Run(t *testing.T, open func(t *testing.T) state.Store) {
	// A genesis writer at epoch 1 with two checkpoints committed: a1 then a2.
	committed := func(t *testing.T) (*harness, writer) {
		h := newHarness(t, open(t), state.Record{})
		w := newWriter(t)
		h.must(h.activate(activation{writer: w}))
		h.must(h.commit(w, 1, 0, nil, head(1, 1, nil, 0xa1), operation(1)))
		h.must(h.commit(w, 1, 1, ptr(digest(0xa1)), head(2, 1, ptr(digest(0xa1)), 0xa2), operation(2)))
		return h, w
	}

	t.Run("genesis activation installs the writer and bumps the epoch", func(t *testing.T) {
		h := newHarness(t, open(t), state.Record{})
		w := newWriter(t)
		r := h.must(h.activate(activation{writer: w}))
		if r.Epoch != 1 || !bytes.Equal(r.Writer.PublicKey, w.pub) || r.PendingChallenge != nil || r.Writer.PCRs != approvedPCRs {
			t.Fatalf("activation recorded %+v", r)
		}
	})

	t.Run("commits advance the checkpoint one sequence at a time", func(t *testing.T) {
		h, _ := committed(t)
		r := h.record()
		if r.Sequence != 2 || r.Checkpoint.CiphertextDigest != digest(0xa2) || r.CurrentOperationID != operation(2) {
			t.Fatalf("record %+v", r)
		}
	})

	t.Run("activation refuses a restored head the record has moved past", func(t *testing.T) {
		h, w := committed(t)
		stale := head(1, 1, nil, 0xa1)
		_, err := h.activate(activation{writer: newWriter(t), restored: &stale})
		refused(t, err, state.ErrCheckpointConflict)
		if r := h.record(); r.Epoch != 1 || !bytes.Equal(r.Writer.PublicKey, w.pub) {
			t.Fatal("a refused activation changed the writer")
		}
	})

	t.Run("activation fences the predecessor", func(t *testing.T) {
		h, old := committed(t)
		current := h.record().Checkpoint
		h.must(h.activate(activation{writer: newWriter(t), restored: current}))
		_, err := h.commit(old, 1, 2, ptr(digest(0xa2)), head(3, 1, ptr(digest(0xa2)), 0xa3), operation(3))
		refused(t, err, state.ErrWriterFenced)
		if r := h.record(); r.Sequence != 2 {
			t.Fatalf("a fenced writer advanced the sequence to %d", r.Sequence)
		}
	})

	t.Run("the store alone refuses a commit from a superseded epoch or key", func(t *testing.T) {
		attempt := func(h *harness, epoch uint64, key ed25519.PublicKey) {
			t.Helper()
			prior := ptr(digest(0xa2))
			_, err := h.store.Commit(context.Background(), state.CommitUpdate{
				Deployment: deployment, Epoch: epoch, WriterPublicKey: key, ExpectedSequence: 2, PriorDigest: prior,
				Head: head(3, epoch, prior, 0xa3), OperationID: operation(3),
			})
			var failed *state.ConditionFailed
			if !errors.As(err, &failed) || failed.Current.Epoch != 2 {
				t.Fatalf("epoch %d: got %v", epoch, err)
			}
		}
		// Re-activated under the same key, only the epoch tells the two writers apart.
		h, w := committed(t)
		h.must(h.activate(activation{writer: w, restored: h.record().Checkpoint}))
		attempt(h, 1, w.pub)

		h, old := committed(t)
		h.must(h.activate(activation{writer: newWriter(t), restored: h.record().Checkpoint}))
		attempt(h, 2, old.pub)
	})

	t.Run("the store alone refuses an activation on a stale epoch, challenge, policy or head", func(t *testing.T) {
		h, _ := committed(t)
		rec := h.record()
		now := uint64(h.now.UnixMilli())
		for name, mutate := range map[string]func(*state.Activation){
			"stale epoch":       func(a *state.Activation) { a.ExpectedEpoch = 0 },
			"another challenge": func(a *state.Activation) { a.ChallengeID = "spent" },
			"expired challenge": func(a *state.Activation) { a.NowMs += 120_000 },
			"older policy":      func(a *state.Activation) { a.ReleasePolicyVersion = 0 },
			"moved head":        func(a *state.Activation) { stale := head(1, 1, nil, 0xa1); a.Restored = &stale },
		} {
			c := state.Challenge{ID: "fresh-" + name, Nonce: []byte{1}, ExpiresAtMs: now + 60_000}
			if err := h.store.PutChallenge(context.Background(), deployment, c, now); err != nil {
				t.Fatal(err)
			}
			a := state.Activation{
				Deployment: deployment, ExpectedEpoch: rec.Epoch, ChallengeID: c.ID, NowMs: now,
				ReleasePolicyVersion: 1, Restored: rec.Checkpoint, Writer: state.Writer{PublicKey: newWriter(t).pub},
			}
			mutate(&a)
			var failed *state.ConditionFailed
			if _, err := h.store.Activate(context.Background(), a); !errors.As(err, &failed) {
				t.Fatalf("%s: got %v", name, err)
			}
		}
		if r := h.record(); r.Epoch != rec.Epoch {
			t.Fatal("a refused activation moved the epoch")
		}
	})

	t.Run("a commit whose prior digest is not the committed one is a conflict", func(t *testing.T) {
		h, w := committed(t)
		_, err := h.commit(w, 1, 2, ptr(digest(0xbb)), head(3, 1, ptr(digest(0xbb)), 0xa3), operation(3))
		refused(t, err, state.ErrCheckpointConflict)
	})

	t.Run("a commit behind the committed sequence is a conflict", func(t *testing.T) {
		h, w := committed(t)
		_, err := h.commit(w, 1, 1, ptr(digest(0xa1)), head(2, 1, ptr(digest(0xa1)), 0xb2), operation(3))
		refused(t, err, state.ErrCheckpointConflict)
	})

	t.Run("a checkpoint that is not the next one is refused", func(t *testing.T) {
		h, w := committed(t)
		prior := ptr(digest(0xa2))
		for name, bad := range map[string]wire.Head{
			"skips a sequence":     head(4, 1, prior, 0xa3),
			"sealed under epoch 0": head(3, 0, prior, 0xa3),
			"links elsewhere":      head(3, 1, ptr(digest(0xbb)), 0xa3),
			"older schema":         func() wire.Head { x := head(3, 1, prior, 0xa3); x.SchemaVersion = 11; return x }(),
			"another schema":       func() wire.Head { x := head(3, 1, prior, 0xa3); x.Schema = "lnurl.enclave.checkpoint.v1"; return x }(),
		} {
			_, err := h.commit(w, 1, 2, prior, bad, operation(3))
			if !errors.Is(err, state.ErrHead) {
				t.Fatalf("%s: got %v", name, err)
			}
		}
		if r := h.record(); r.Sequence != 2 {
			t.Fatal("a refused checkpoint was committed")
		}
	})

	t.Run("a retried commit that already landed succeeds again, and writes nothing", func(t *testing.T) {
		h, w := committed(t)
		before := h.record()
		r := h.must(h.commit(w, 1, 1, ptr(digest(0xa1)), head(2, 1, ptr(digest(0xa1)), 0xa2), operation(2)))
		if r.Sequence != 2 || r.RecordVersion != before.RecordVersion {
			t.Fatalf("the retry wrote: %+v", r)
		}
	})

	t.Run("an operation id reused for another checkpoint is refused", func(t *testing.T) {
		h, w := committed(t)
		_, err := h.commit(w, 1, 2, ptr(digest(0xa2)), head(3, 1, ptr(digest(0xa2)), 0xa3), operation(2))
		refused(t, err, state.ErrOperationReused)
	})

	t.Run("a fenced writer's retry of a commit that landed before the fence reports it landed", func(t *testing.T) {
		h, old := committed(t)
		h.must(h.activate(activation{writer: newWriter(t), restored: h.record().Checkpoint}))
		r := h.must(h.commit(old, 1, 1, ptr(digest(0xa1)), head(2, 1, ptr(digest(0xa1)), 0xa2), operation(2)))
		if r.Epoch != 2 {
			t.Fatalf("the answer hid the fence: epoch %d", r.Epoch)
		}
	})

	t.Run("a commit signed by anyone but the writer is refused", func(t *testing.T) {
		h, _ := committed(t)
		_, err := h.commit(newWriter(t), 1, 2, ptr(digest(0xa2)), head(3, 1, ptr(digest(0xa2)), 0xa3), operation(3))
		refused(t, err, state.ErrSignature)
	})

	t.Run("an activation must be quoted, approved and proved", func(t *testing.T) {
		h := newHarness(t, open(t), state.Record{})
		w := newWriter(t)
		_, err := h.activate(activation{writer: w, pcrs: unknownPCRs})
		refused(t, err, state.ErrNotApproved)
		_, err = h.activate(activation{writer: w, quoted: []byte("another payload")})
		refused(t, err, state.ErrQuote)
		_, err = h.activate(activation{writer: w, provedBy: newWriter(t).priv})
		refused(t, err, state.ErrProof)
		if r := h.record(); r.Epoch != 0 || r.Writer != nil {
			t.Fatal("a refused activation installed a writer")
		}
	})

	t.Run("an expired or replaced challenge cannot activate", func(t *testing.T) {
		h := newHarness(t, open(t), state.Record{})
		old, err := h.auth.Challenge(context.Background(), deployment)
		if err != nil {
			t.Fatal(err)
		}
		_, err = h.activate(activation{writer: newWriter(t), stale: &old})
		refused(t, err, state.ErrChallenge)

		live, _ := h.auth.Challenge(context.Background(), deployment)
		h.now = h.now.Add(2 * time.Minute)
		_, err = h.activate(activation{writer: newWriter(t), stale: &live})
		refused(t, err, state.ErrChallenge)
	})

	t.Run("the release policy only moves forward", func(t *testing.T) {
		h := newHarness(t, open(t), state.Record{})
		h.must(h.activate(activation{writer: newWriter(t), pcrs: newerPCRs, policy: 2}))
		_, err := h.activate(activation{writer: newWriter(t)})
		refused(t, err, state.ErrPolicyDowngrade)
	})

	t.Run("an unknown deployment is refused, never created", func(t *testing.T) {
		store := open(t)
		auth := &state.Authority{Store: store, Quotes: quotes{}, Approvals: approvals{}, Now: time.Now, ChallengeTTL: time.Minute}
		_, err := auth.Challenge(context.Background(), "nobody")
		refused(t, err, state.ErrNotFound)
		if _, err := store.Get(context.Background(), "nobody"); !errors.Is(err, state.ErrNotFound) {
			t.Fatalf("asking about a deployment created it: %v", err)
		}
	})

	t.Run("a deployment is created once, and never over an existing record", func(t *testing.T) {
		h, _ := committed(t)
		err := h.store.Create(context.Background(), state.Record{Deployment: deployment, Prefix: "lnurl/db"})
		refused(t, err, state.ErrExists)
		if r := h.record(); r.Sequence != 2 || r.Epoch != 1 {
			t.Fatalf("a second create touched the record: %+v", r)
		}
	})

	t.Run("an adopted chain continues under the first granted epoch", func(t *testing.T) {
		adopted := head(5, 0, ptr(digest(0x9f)), 0xa5)
		h := newHarness(t, open(t), state.Record{Sequence: 5, Checkpoint: &adopted})
		w := newWriter(t)
		h.must(h.activate(activation{writer: w, restored: &adopted}))
		r := h.must(h.commit(w, 1, 5, ptr(digest(0xa5)), head(6, 1, ptr(digest(0xa5)), 0xa6), operation(6)))
		if r.Sequence != 6 || r.Checkpoint.SealEpoch != 1 {
			t.Fatalf("record %+v", r)
		}
	})
}

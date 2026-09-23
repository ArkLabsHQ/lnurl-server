package httpapi

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/sign"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/store/memory"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

const deployment = "lnurl-test"

type testSigner struct{ key *ecdsa.PrivateKey }

func (s testSigner) PublicKey(context.Context) ([]byte, error) {
	return x509.MarshalPKIXPublicKey(&s.key.PublicKey)
}

func (s testSigner) Sign(_ context.Context, payload []byte) ([]byte, error) {
	digest := sha256.Sum256(payload)
	return ecdsa.SignASN1(rand.Reader, s.key, digest[:])
}

type quote struct {
	Nonce, UserData []byte
}

type quotes struct{}

func (quotes) Verify(document, nonce, userData []byte) ([3]string, error) {
	var q quote
	if err := json.Unmarshal(document, &q); err != nil || !bytes.Equal(q.Nonce, nonce) || !bytes.Equal(q.UserData, userData) {
		return [3]string{}, errors.New("quote binds another nonce or payload")
	}
	return [3]string{strings.Repeat("01", 48), strings.Repeat("02", 48), strings.Repeat("03", 48)}, nil
}

type approvals struct{}

func (approvals) Approved(context.Context, string, [3]string) (uint32, bool, error) {
	return 1, true, nil
}

type failingStore struct{ state.Store }

func (failingStore) Get(context.Context, string) (*state.Record, error) {
	return nil, errors.New("dynamodb: table lnurl-authority in account 123456789012 is throttled")
}

type fixture struct {
	t      *testing.T
	url    string
	signer testSigner
}

func newFixture(t *testing.T, wrap func(state.Store) state.Store) *fixture {
	store := memory.New()
	if err := store.Create(context.Background(), state.Record{Deployment: deployment, Prefix: "lnurl/db"}); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.UnixMilli(1_790_000_000_000) }
	var s state.Store = store
	if wrap != nil {
		s = wrap(store)
	}
	f := &fixture{t: t, signer: testSigner{key}}
	server := httptest.NewServer((&Server{
		Authority: &state.Authority{Store: s, Quotes: quotes{}, Approvals: approvals{}, Now: now, ChallengeTTL: time.Minute},
		Signer:    f.signer, Now: now, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}).Handler())
	t.Cleanup(server.Close)
	f.url = server.URL
	return f
}

type reply struct {
	status      int
	Error       string     `json:"error"`
	Message     string     `json:"message"`
	Statement   *Statement `json:"statement"`
	ChallengeID string     `json:"challengeId"`
	Nonce       string     `json:"nonce"`
}

func (f *fixture) send(method, path, body string) reply {
	f.t.Helper()
	req, _ := http.NewRequest(method, f.url+path, strings.NewReader(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	r := reply{status: res.StatusCode}
	_ = json.NewDecoder(res.Body).Decode(&r)
	return r
}

func (f *fixture) post(path string, body any) reply {
	f.t.Helper()
	data, _ := json.Marshal(body)
	return f.send(http.MethodPost, path, string(data))
}

// verified checks a statement's signature under the fixture's key and decodes it.
func (f *fixture) verified(st *Statement) wire.Statement {
	f.t.Helper()
	if st == nil {
		f.t.Fatal("no statement")
	}
	digest := sha256.Sum256(st.Payload)
	if !ecdsa.VerifyASN1(&f.signer.key.PublicKey, digest[:], st.Signature) {
		f.t.Fatal("the statement does not verify under the authority key")
	}
	m, err := wire.DecodeStatement(st.Payload)
	if err != nil {
		f.t.Fatal(err)
	}
	spki, _ := f.signer.PublicKey(context.Background())
	if m.AuthorityKeyID != sign.KeyID(spki) {
		f.t.Fatalf("statement names key %s", m.AuthorityKeyID)
	}
	return m
}

func (f *fixture) activate(writer ed25519.PrivateKey, restored *wire.Head) (reply, []byte) {
	f.t.Helper()
	c := f.post("/v1/challenge", map[string]string{"deployment": deployment, "purpose": "activate"})
	nonce, _ := hex.DecodeString(c.Nonce)
	payload, err := wire.EncodeActivate(wire.Activate{
		Deployment: deployment, ChallengeID: c.ChallengeID, ChallengeNonce: nonce,
		WriterPublicKey: wire.Bytes(writer.Public().(ed25519.PublicKey)), ReleasePolicyVersion: 1, Restored: restored,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	userData := sha256.Sum256(payload)
	document, _ := json.Marshal(quote{Nonce: nonce, UserData: userData[:]})
	return f.post("/v1/writer/activate", map[string][]byte{
		"payload": payload, "attestationDocument": document, "proofOfPossession": ed25519.Sign(writer, payload),
	}), payload
}

func (f *fixture) commit(writer ed25519.PrivateKey, epoch, expected uint64, prior *string, head wire.Head, operation string) (reply, []byte) {
	f.t.Helper()
	payload, err := wire.EncodeCommit(wire.Commit{
		Deployment: deployment, Epoch: epoch, OperationID: operation, ExpectedSequence: expected, PriorDigest: prior, Head: head,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return f.post("/v1/checkpoint/commit", map[string][]byte{"payload": payload, "signature": ed25519.Sign(writer, payload)}), payload
}

func head(sequence, sealEpoch uint64, previous *string, tag byte) wire.Head {
	ciphertext := hex.EncodeToString(bytes.Repeat([]byte{tag}, 32))
	return wire.Head{
		Schema: state.HeadSchema, Prefix: "lnurl/db", SchemaVersion: 12, SealEpoch: sealEpoch, Sequence: sequence,
		PreviousDigest: previous, Digest: hex.EncodeToString(bytes.Repeat([]byte{^tag}, 32)), Size: 4096,
		CiphertextDigest: ciphertext, Key: "lnurl/db/" + ciphertext + ".sqlite.br.enc",
	}
}

func newWriter(t *testing.T) ed25519.PrivateKey {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func bound(payload []byte) []byte {
	sum := sha256.Sum256(payload)
	return sum[:]
}

func TestStateIsASignedStatementEchoingTheCallerNonce(t *testing.T) {
	f := newFixture(t, nil)
	nonce := strings.Repeat("5e", 16)
	r := f.post("/v1/state", map[string]string{"deployment": deployment, "nonce": nonce})
	m := f.verified(r.Statement)
	if r.status != http.StatusOK || hex.EncodeToString(m.CallerNonce) != nonce || m.Deployment != deployment || m.ActiveEpoch != 0 || m.Head != nil {
		t.Fatalf("%d %+v", r.status, m)
	}
}

func TestActivationAndCommitsAnswerWithStatementsBoundToTheirRequest(t *testing.T) {
	f := newFixture(t, nil)
	writer := newWriter(t)
	r, payload := f.activate(writer, nil)
	m := f.verified(r.Statement)
	if r.status != http.StatusOK || m.ActiveEpoch != 1 || !bytes.Equal(m.ActiveWriterPublicKey, writer.Public().(ed25519.PublicKey)) || !bytes.Equal(m.CallerNonce, bound(payload)) {
		t.Fatalf("activation answered %d %+v", r.status, m)
	}
	r, payload = f.commit(writer, 1, 0, nil, head(1, 1, nil, 0xa1), strings.Repeat("01", 16))
	m = f.verified(r.Statement)
	if r.status != http.StatusOK || m.Sequence != 1 || m.Head.CiphertextDigest != head(1, 1, nil, 0xa1).CiphertextDigest ||
		*m.CurrentOperationID != strings.Repeat("01", 16) || !bytes.Equal(m.CallerNonce, bound(payload)) {
		t.Fatalf("commit answered %d %+v", r.status, m)
	}
}

func TestEveryCommitOutcomeCarriesTheStateToActOn(t *testing.T) {
	f := newFixture(t, nil)
	writer := newWriter(t)
	f.activate(writer, nil)
	first := head(1, 1, nil, 0xa1)
	op := strings.Repeat("01", 16)
	f.commit(writer, 1, 0, nil, first, op)
	prior := &first.CiphertextDigest

	if r, _ := f.commit(writer, 1, 0, nil, first, op); r.status != http.StatusOK || f.verified(r.Statement).Sequence != 1 {
		t.Fatalf("a landed commit's retry answered %d %s", r.status, r.Error)
	}
	for name, c := range map[string]struct {
		expected uint64
		prior    *string
		head     wire.Head
		op       string
		status   int
		code     string
	}{
		"reused operation": {1, prior, head(2, 1, prior, 0xa2), op, http.StatusConflict, "operation_reused"},
		"moved chain":      {1, ptr(strings.Repeat("bb", 32)), head(2, 1, ptr(strings.Repeat("bb", 32)), 0xa2), strings.Repeat("02", 16), http.StatusConflict, "checkpoint_conflict"},
		"wrong seal epoch": {1, prior, head(2, 0, prior, 0xa2), strings.Repeat("03", 16), http.StatusUnprocessableEntity, "checkpoint_refused"},
	} {
		r, payload := f.commit(writer, 1, c.expected, c.prior, c.head, c.op)
		if r.status != c.status || r.Error != c.code {
			t.Fatalf("%s: answered %d %s", name, r.status, r.Error)
		}
		if c.status == http.StatusConflict {
			if m := f.verified(r.Statement); m.Sequence != 1 || !bytes.Equal(m.CallerNonce, bound(payload)) {
				t.Fatalf("%s: conflict statement %+v", name, m)
			}
		}
	}
	if r, _ := f.commit(newWriter(t), 1, 1, prior, head(2, 1, prior, 0xa2), strings.Repeat("04", 16)); r.status != http.StatusUnauthorized || r.Statement != nil {
		t.Fatalf("a stranger's commit answered %d with statement %v", r.status, r.Statement != nil)
	}

	f.activate(newWriter(t), &first)
	r, _ := f.commit(writer, 1, 1, prior, head(2, 1, prior, 0xa2), strings.Repeat("05", 16))
	if r.status != http.StatusConflict || r.Error != "writer_fenced" || f.verified(r.Statement).ActiveEpoch != 2 {
		t.Fatalf("a fenced writer's commit answered %d %s", r.status, r.Error)
	}
}

func TestRefusesMalformedRequests(t *testing.T) {
	f := newFixture(t, nil)
	for name, c := range map[string]struct {
		method, path, body string
		status             int
	}{
		"not JSON":        {http.MethodPost, "/v1/state", "{", http.StatusBadRequest},
		"unknown field":   {http.MethodPost, "/v1/state", `{"deployment":"lnurl-test","nonce":"` + strings.Repeat("5e", 16) + `","extra":1}`, http.StatusBadRequest},
		"trailing data":   {http.MethodPost, "/v1/state", `{"deployment":"lnurl-test","nonce":"` + strings.Repeat("5e", 16) + `"} {}`, http.StatusBadRequest},
		"short nonce":     {http.MethodPost, "/v1/state", `{"deployment":"lnurl-test","nonce":"` + strings.Repeat("5e", 15) + `"}`, http.StatusBadRequest},
		"oversized":       {http.MethodPost, "/v1/state", `{"deployment":"` + strings.Repeat("a", maxBody) + `"}`, http.StatusBadRequest},
		"other purpose":   {http.MethodPost, "/v1/challenge", `{"deployment":"lnurl-test","purpose":"commit"}`, http.StatusBadRequest},
		"unknown":         {http.MethodPost, "/v1/state", `{"deployment":"nobody","nonce":"` + strings.Repeat("5e", 16) + `"}`, http.StatusNotFound},
		"unknown, again":  {http.MethodPost, "/v1/challenge", `{"deployment":"nobody","purpose":"activate"}`, http.StatusNotFound},
		"wrong method":    {http.MethodGet, "/v1/state", "", http.StatusMethodNotAllowed},
		"unknown payload": {http.MethodPost, "/v1/checkpoint/commit", `{"payload":"AAAA","signature":"AAAA"}`, http.StatusBadRequest},
	} {
		if r := f.send(c.method, c.path, c.body); r.status != c.status {
			t.Errorf("%s: answered %d, want %d", name, r.status, c.status)
		}
	}
}

func TestAStoreFailureIsA503ThatKeepsItsDetailToItself(t *testing.T) {
	f := newFixture(t, func(s state.Store) state.Store { return failingStore{s} })
	r := f.post("/v1/state", map[string]string{"deployment": deployment, "nonce": strings.Repeat("5e", 16)})
	if r.status != http.StatusServiceUnavailable || r.Error != "unavailable" || strings.Contains(r.Message, "dynamodb") || strings.Contains(r.Message, "123456789012") {
		t.Fatalf("answered %d %q", r.status, r.Message)
	}
}

func ptr(s string) *string { return &s }

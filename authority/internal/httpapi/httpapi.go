// Package httpapi is the authority's HTTP surface: four JSON endpoints over the state
// machine, each answering with a statement the enclave verifies against a pinned key.
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/sign"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

const maxBody = 64 << 10

type Server struct {
	Authority *state.Authority
	Signer    sign.Signer
	Now       func() time.Time
	Log       *slog.Logger
}

// Statement is a signed wire.Statement; both fields are base64 in JSON.
type Statement struct {
	Payload   []byte `json:"payload"`
	Signature []byte `json:"signature"`
}

type statementResponse struct {
	Statement *Statement `json:"statement"`
}

type errorResponse struct {
	Error     string     `json:"error"`
	Message   string     `json:"message"`
	Statement *Statement `json:"statement,omitempty"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/challenge", s.challenge)
	mux.HandleFunc("POST /v1/writer/activate", s.activate)
	mux.HandleFunc("POST /v1/checkpoint/commit", s.commit)
	mux.HandleFunc("POST /v1/state", s.state)
	return mux
}

func (s *Server) challenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Deployment string `json:"deployment"`
		Purpose    string `json:"purpose"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err, nil)
		return
	}
	if req.Purpose != "activate" {
		s.fail(w, r, fmt.Errorf("%w: purpose must be \"activate\"", state.ErrMalformed), nil)
		return
	}
	c, err := s.Authority.Challenge(r.Context(), req.Deployment)
	if err != nil {
		s.fail(w, r, err, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challengeId": c.ID, "nonce": hex.EncodeToString(c.Nonce), "expiresAtUnixMs": c.ExpiresAtMs,
	})
}

func (s *Server) activate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Payload             []byte `json:"payload"`
		AttestationDocument []byte `json:"attestationDocument"`
		ProofOfPossession   []byte `json:"proofOfPossession"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err, nil)
		return
	}
	bound := sha256.Sum256(req.Payload)
	rec, err := s.Authority.Activate(r.Context(), state.ActivateRequest{
		Payload: req.Payload, AttestationDocument: req.AttestationDocument, ProofOfPossession: req.ProofOfPossession,
	})
	s.answer(w, r, rec, err, bound[:])
}

func (s *Server) commit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Payload   []byte `json:"payload"`
		Signature []byte `json:"signature"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err, nil)
		return
	}
	bound := sha256.Sum256(req.Payload)
	rec, err := s.Authority.Commit(r.Context(), state.CommitRequest{Payload: req.Payload, Signature: req.Signature})
	s.answer(w, r, rec, err, bound[:])
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Deployment string `json:"deployment"`
		Nonce      string `json:"nonce"`
	}
	if err := decode(w, r, &req); err != nil {
		s.fail(w, r, err, nil)
		return
	}
	nonce, err := hex.DecodeString(req.Nonce)
	if err != nil || len(nonce) < 16 || len(nonce) > 64 {
		s.fail(w, r, fmt.Errorf("%w: nonce must be 16 to 64 bytes of hex", state.ErrMalformed), nil)
		return
	}
	rec, err := s.Authority.State(r.Context(), req.Deployment)
	s.answer(w, r, rec, err, nonce)
}

// answer replies to a transition with a statement of the record it left. Statements
// answering activate or commit carry the SHA-256 of the request payload as their nonce,
// so a statement replayed from another request cannot pass as this one's answer.
func (s *Server) answer(w http.ResponseWriter, r *http.Request, rec *state.Record, err error, nonce []byte) {
	if err != nil {
		s.fail(w, r, err, nonce)
		return
	}
	st, err := s.statement(r, rec, nonce)
	if err != nil {
		s.fail(w, r, err, nil)
		return
	}
	writeJSON(w, http.StatusOK, statementResponse{Statement: st})
}

func (s *Server) statement(r *http.Request, rec *state.Record, nonce []byte) (*Statement, error) {
	spki, err := s.Signer.PublicKey(r.Context())
	if err != nil {
		return nil, err
	}
	m := wire.Statement{
		AuthorityKeyID: sign.KeyID(spki), Deployment: rec.Deployment, CallerNonce: nonce,
		IssuedAtUnixMs: uint64(s.Now().UnixMilli()), ActiveEpoch: rec.Epoch,
		ReleasePolicyVersion: rec.ReleasePolicyVersion, Sequence: rec.Sequence, Head: rec.Checkpoint,
	}
	if rec.Writer != nil {
		m.ActiveWriterPublicKey = rec.Writer.PublicKey
	}
	if rec.CurrentOperationID != "" {
		op := rec.CurrentOperationID
		m.CurrentOperationID = &op
	}
	payload, err := wire.EncodeStatement(m)
	if err != nil {
		return nil, err
	}
	signature, err := s.Signer.Sign(r.Context(), payload)
	if err != nil {
		return nil, err
	}
	return &Statement{Payload: payload, Signature: signature}, nil
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error, nonce []byte) {
	status, code := classify(err)
	body := errorResponse{Error: code, Message: err.Error()}
	if status == http.StatusServiceUnavailable {
		// A store or KMS failure's detail stays in the authority's own log.
		s.log().Error("authority_unavailable", "path", r.URL.Path, "error", err)
		body.Message = "the authority cannot answer now; retry"
	}
	var conflict *state.Conflict
	if errors.As(err, &conflict) && nonce != nil {
		if st, serr := s.statement(r, conflict.Current, nonce); serr == nil {
			body.Statement = st
		}
	}
	writeJSON(w, status, body)
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func classify(err error) (int, string) {
	switch {
	case errors.Is(err, state.ErrMalformed):
		return http.StatusBadRequest, "malformed"
	case errors.Is(err, state.ErrNotFound):
		return http.StatusNotFound, "unknown_deployment"
	case errors.Is(err, state.ErrSignature):
		return http.StatusUnauthorized, "signature"
	case errors.Is(err, state.ErrQuote):
		return http.StatusForbidden, "attestation"
	case errors.Is(err, state.ErrNotApproved):
		return http.StatusForbidden, "not_approved"
	case errors.Is(err, state.ErrPolicyDowngrade):
		return http.StatusForbidden, "policy_downgrade"
	case errors.Is(err, state.ErrProof):
		return http.StatusForbidden, "proof"
	case errors.Is(err, state.ErrHead):
		return http.StatusUnprocessableEntity, "checkpoint_refused"
	case errors.Is(err, state.ErrChallenge):
		return http.StatusConflict, "challenge"
	case errors.Is(err, state.ErrWriterFenced):
		return http.StatusConflict, "writer_fenced"
	case errors.Is(err, state.ErrOperationReused):
		return http.StatusConflict, "operation_reused"
	case errors.Is(err, state.ErrCheckpointConflict):
		return http.StatusConflict, "checkpoint_conflict"
	}
	return http.StatusServiceUnavailable, "unavailable"
}

func decode(w http.ResponseWriter, r *http.Request, into any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return fmt.Errorf("%w: %v", state.ErrMalformed, err)
	}
	if dec.More() {
		return fmt.Errorf("%w: trailing data after the request", state.ErrMalformed)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

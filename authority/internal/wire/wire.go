// Package wire is the canonical encoding of every payload the authority signs or
// verifies. Payloads travel as these bytes and are parsed back out of them; no JSON
// form is ever signed.
package wire

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

const (
	TagActivate  = "lnurl.enclave.authority.activate.v1"
	TagCommit    = "lnurl.enclave.authority.commit.v1"
	TagStatement = "lnurl.enclave.authority.statement.v1"

	// MaxSafeInteger is the largest integer TypeScript holds exactly; both sides refuse above it.
	MaxSafeInteger = 1<<53 - 1

	version        = 1
	snapshotSuffix = ".sqlite.br.enc"
)

// Bytes marshals as lowercase hex, so the shared vectors read the same in both languages.
type Bytes []byte

func (b Bytes) MarshalJSON() ([]byte, error) { return json.Marshal(hex.EncodeToString(b)) }

func (b *Bytes) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	decoded, err := hex.DecodeString(s)
	if err != nil {
		return err
	}
	*b = decoded
	return nil
}

// Head is a checkpoint as the enclave sealed it. SealEpoch is the writer epoch bound
// into that object's associated data, not the epoch active now.
type Head struct {
	Schema           string  `json:"schema"`
	Prefix           string  `json:"prefix"`
	SchemaVersion    uint32  `json:"schemaVersion"`
	SealEpoch        uint64  `json:"sealEpoch"`
	Sequence         uint64  `json:"sequence"`
	PreviousDigest   *string `json:"previousDigest"`
	Digest           string  `json:"digest"`
	Size             uint64  `json:"size"`
	CiphertextDigest string  `json:"ciphertextDigest"`
	Key              string  `json:"key"`
}

type Activate struct {
	Deployment           string `json:"deployment"`
	ChallengeID          string `json:"challengeId"`
	ChallengeNonce       Bytes  `json:"challengeNonce"`
	WriterPublicKey      Bytes  `json:"writerPublicKey"`
	ReleasePolicyVersion uint32 `json:"releasePolicyVersion"`
	Restored             *Head  `json:"restored"`
}

type Commit struct {
	Deployment       string  `json:"deployment"`
	Epoch            uint64  `json:"epoch"`
	OperationID      string  `json:"operationId"`
	ExpectedSequence uint64  `json:"expectedSequence"`
	PriorDigest      *string `json:"priorDigest"`
	Head             Head    `json:"head"`
}

type Statement struct {
	AuthorityKeyID        string  `json:"authorityKeyId"`
	Deployment            string  `json:"deployment"`
	CallerNonce           Bytes   `json:"callerNonce"`
	IssuedAtUnixMs        uint64  `json:"issuedAtUnixMs"`
	ActiveEpoch           uint64  `json:"activeEpoch"`
	ActiveWriterPublicKey Bytes   `json:"activeWriterPublicKey"`
	ReleasePolicyVersion  uint32  `json:"releasePolicyVersion"`
	Sequence              uint64  `json:"sequence"`
	Head                  *Head   `json:"head"`
	CurrentOperationID    *string `json:"currentOperationId"`
}

func EncodeActivate(m Activate) ([]byte, error) {
	e := newEncoder(TagActivate)
	e.text("deployment", m.Deployment)
	e.text("challengeId", m.ChallengeID)
	e.bytes("challengeNonce", m.ChallengeNonce)
	e.bytes("writerPublicKey", m.WriterPublicKey)
	e.u32(m.ReleasePolicyVersion)
	e.optHead(m.Restored)
	return e.finish()
}

func DecodeActivate(payload []byte) (Activate, error) {
	d := newDecoder(payload, TagActivate)
	var m Activate
	m.Deployment = d.text("deployment")
	m.ChallengeID = d.text("challengeId")
	m.ChallengeNonce = d.bytes("challengeNonce")
	m.WriterPublicKey = d.bytes("writerPublicKey")
	m.ReleasePolicyVersion = d.u32("releasePolicyVersion")
	m.Restored = d.optHead()
	return m, d.finish()
}

func EncodeCommit(m Commit) ([]byte, error) {
	e := newEncoder(TagCommit)
	e.text("deployment", m.Deployment)
	e.u64("epoch", m.Epoch)
	e.text("operationId", m.OperationID)
	e.u64("expectedSequence", m.ExpectedSequence)
	e.optDigest("priorDigest", m.PriorDigest)
	e.head(m.Head)
	return e.finish()
}

func DecodeCommit(payload []byte) (Commit, error) {
	d := newDecoder(payload, TagCommit)
	var m Commit
	m.Deployment = d.text("deployment")
	m.Epoch = d.u64("epoch")
	m.OperationID = d.text("operationId")
	m.ExpectedSequence = d.u64("expectedSequence")
	m.PriorDigest = d.optDigest("priorDigest")
	m.Head = d.head()
	return m, d.finish()
}

func EncodeStatement(m Statement) ([]byte, error) {
	e := newEncoder(TagStatement)
	e.text("authorityKeyId", m.AuthorityKeyID)
	e.text("deployment", m.Deployment)
	e.bytes("callerNonce", m.CallerNonce)
	e.u64("issuedAtUnixMs", m.IssuedAtUnixMs)
	e.u64("activeEpoch", m.ActiveEpoch)
	e.bytes("activeWriterPublicKey", m.ActiveWriterPublicKey)
	e.u32(m.ReleasePolicyVersion)
	e.u64("sequence", m.Sequence)
	e.optHead(m.Head)
	e.optText("currentOperationId", m.CurrentOperationID)
	return e.finish()
}

func DecodeStatement(payload []byte) (Statement, error) {
	d := newDecoder(payload, TagStatement)
	var m Statement
	m.AuthorityKeyID = d.text("authorityKeyId")
	m.Deployment = d.text("deployment")
	m.CallerNonce = d.bytes("callerNonce")
	m.IssuedAtUnixMs = d.u64("issuedAtUnixMs")
	m.ActiveEpoch = d.u64("activeEpoch")
	m.ActiveWriterPublicKey = d.bytes("activeWriterPublicKey")
	m.ReleasePolicyVersion = d.u32("releasePolicyVersion")
	m.Sequence = d.u64("sequence")
	m.Head = d.optHead()
	m.CurrentOperationID = d.optText("currentOperationId")
	return m, d.finish()
}

type encoder struct {
	buf []byte
	err error
}

func newEncoder(tag string) *encoder {
	e := &encoder{}
	e.text("tag", tag)
	e.buf = append(e.buf, version)
	return e
}

func (e *encoder) fail(field, problem string) {
	if e.err == nil {
		e.err = fmt.Errorf("wire: %s %s", field, problem)
	}
}

func (e *encoder) u32(v uint32) { e.buf = binary.BigEndian.AppendUint32(e.buf, v) }

func (e *encoder) u64(field string, v uint64) {
	if v > MaxSafeInteger {
		e.fail(field, "exceeds 2^53-1")
	}
	e.buf = binary.BigEndian.AppendUint64(e.buf, v)
}

func (e *encoder) bytes(field string, b []byte) {
	if len(b) > 0xffff {
		e.fail(field, "is longer than 65535 bytes")
		return
	}
	e.buf = binary.BigEndian.AppendUint16(e.buf, uint16(len(b)))
	e.buf = append(e.buf, b...)
}

func (e *encoder) text(field, s string) {
	if !printableASCII(s) {
		e.fail(field, "must be printable ASCII")
	}
	e.bytes(field, []byte(s))
}

func (e *encoder) digest(field, h string) {
	raw, ok := parseDigest(h)
	if !ok {
		e.fail(field, "must be 64 lowercase hex characters")
		raw = make([]byte, 32)
	}
	e.buf = append(e.buf, raw...)
}

func (e *encoder) present(ok bool) {
	if ok {
		e.buf = append(e.buf, 1)
	} else {
		e.buf = append(e.buf, 0)
	}
}

func (e *encoder) optDigest(field string, h *string) {
	e.present(h != nil)
	if h != nil {
		e.digest(field, *h)
	}
}

func (e *encoder) optText(field string, s *string) {
	e.present(s != nil)
	if s != nil {
		e.text(field, *s)
	}
}

func (e *encoder) optHead(h *Head) {
	e.present(h != nil)
	if h != nil {
		e.head(*h)
	}
}

func (e *encoder) head(h Head) {
	if h.Key != h.Prefix+"/"+h.CiphertextDigest+snapshotSuffix {
		e.fail("head.key", "does not name its ciphertext digest")
	}
	e.text("head.schema", h.Schema)
	e.text("head.prefix", h.Prefix)
	e.u32(h.SchemaVersion)
	e.u64("head.sealEpoch", h.SealEpoch)
	e.u64("head.sequence", h.Sequence)
	e.optDigest("head.previousDigest", h.PreviousDigest)
	e.digest("head.digest", h.Digest)
	e.u64("head.size", h.Size)
	e.digest("head.ciphertextDigest", h.CiphertextDigest)
	e.text("head.key", h.Key)
}

func (e *encoder) finish() ([]byte, error) {
	if e.err != nil {
		return nil, e.err
	}
	return e.buf, nil
}

type decoder struct {
	buf []byte
	off int
	err error
}

func newDecoder(payload []byte, tag string) *decoder {
	d := &decoder{buf: payload}
	if got := d.text("tag"); d.err == nil && got != tag {
		d.fail("tag", fmt.Sprintf("is %q, want %q", got, tag))
	}
	if v := d.u8("version"); d.err == nil && v != version {
		d.fail("version", fmt.Sprintf("is %d, want %d", v, version))
	}
	return d
}

func (d *decoder) fail(field, problem string) {
	if d.err == nil {
		d.err = fmt.Errorf("wire: %s %s", field, problem)
	}
}

func (d *decoder) take(field string, n int) []byte {
	if d.err != nil {
		return nil
	}
	if len(d.buf)-d.off < n {
		d.fail(field, "is truncated")
		return nil
	}
	b := d.buf[d.off : d.off+n]
	d.off += n
	return b
}

func (d *decoder) u8(field string) uint8 {
	if b := d.take(field, 1); b != nil {
		return b[0]
	}
	return 0
}

func (d *decoder) u32(field string) uint32 {
	if b := d.take(field, 4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}

func (d *decoder) u64(field string) uint64 {
	b := d.take(field, 8)
	if b == nil {
		return 0
	}
	v := binary.BigEndian.Uint64(b)
	if v > MaxSafeInteger {
		d.fail(field, "exceeds 2^53-1")
	}
	return v
}

func (d *decoder) bytes(field string) []byte {
	n := d.take(field, 2)
	if n == nil {
		return nil
	}
	// Copied, so a decoded message never aliases the payload it came from.
	return append([]byte(nil), d.take(field, int(binary.BigEndian.Uint16(n)))...)
}

func (d *decoder) text(field string) string {
	s := string(d.bytes(field))
	if d.err == nil && !printableASCII(s) {
		d.fail(field, "must be printable ASCII")
	}
	return s
}

func (d *decoder) digest(field string) string {
	if b := d.take(field, 32); b != nil {
		return hex.EncodeToString(b)
	}
	return ""
}

func (d *decoder) present(field string) bool {
	switch d.u8(field) {
	case 0:
		return false
	case 1:
		return true
	default:
		d.fail(field, "has an invalid presence byte")
		return false
	}
}

func (d *decoder) optDigest(field string) *string {
	if !d.present(field) {
		return nil
	}
	h := d.digest(field)
	return &h
}

func (d *decoder) optText(field string) *string {
	if !d.present(field) {
		return nil
	}
	s := d.text(field)
	return &s
}

func (d *decoder) optHead() *Head {
	if !d.present("head") {
		return nil
	}
	h := d.head()
	return &h
}

func (d *decoder) head() Head {
	var h Head
	h.Schema = d.text("head.schema")
	h.Prefix = d.text("head.prefix")
	h.SchemaVersion = d.u32("head.schemaVersion")
	h.SealEpoch = d.u64("head.sealEpoch")
	h.Sequence = d.u64("head.sequence")
	h.PreviousDigest = d.optDigest("head.previousDigest")
	h.Digest = d.digest("head.digest")
	h.Size = d.u64("head.size")
	h.CiphertextDigest = d.digest("head.ciphertextDigest")
	h.Key = d.text("head.key")
	if d.err == nil && h.Key != h.Prefix+"/"+h.CiphertextDigest+snapshotSuffix {
		d.fail("head.key", "does not name its ciphertext digest")
	}
	return h
}

func (d *decoder) finish() error {
	if d.err == nil && d.off != len(d.buf) {
		d.fail("payload", "has trailing bytes")
	}
	return d.err
}

func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func parseDigest(h string) ([]byte, bool) {
	if len(h) != 64 {
		return nil, false
	}
	for i := 0; i < len(h); i++ {
		if c := h[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return nil, false
		}
	}
	raw, err := hex.DecodeString(h)
	return raw, err == nil
}

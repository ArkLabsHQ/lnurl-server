package wire

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/wire-vectors.json from the encoder")

var vectorsPath = filepath.Join("..", "..", "testdata", "wire-vectors.json")

type vector struct {
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Message json.RawMessage `json:"message"`
	Hex     string          `json:"hex"`
}

func repeat(pair string, n int) string { return strings.Repeat(pair, n) }

func head(sequence, sealEpoch uint64, previous *string) Head {
	ciphertext := repeat("c3", 32)
	return Head{
		Schema: "lnurl.enclave.checkpoint.v2", Prefix: "lnurl/db", SchemaVersion: 12,
		SealEpoch: sealEpoch, Sequence: sequence, PreviousDigest: previous,
		Digest: repeat("d4", 32), Size: 1_310_720,
		CiphertextDigest: ciphertext, Key: "lnurl/db/" + ciphertext + ".sqlite.br.enc",
	}
}

func samples() []struct {
	name, kind string
	message    any
} {
	prior := repeat("b2", 32)
	operation := repeat("0f", 16)
	writer := Bytes(bytes.Repeat([]byte{0xe7}, 32))
	restored := head(8, 3, &prior)
	return []struct {
		name, kind string
		message    any
	}{
		{"activate-genesis", "activate", Activate{
			Deployment: "lnurl-prod", ChallengeID: "ch-01", ChallengeNonce: bytes.Repeat([]byte{0xa1}, 20),
			WriterPublicKey: writer, ReleasePolicyVersion: 1,
		}},
		{"activate-restored", "activate", Activate{
			Deployment: "lnurl-prod", ChallengeID: "ch-02", ChallengeNonce: bytes.Repeat([]byte{0xa2}, 20),
			WriterPublicKey: writer, ReleasePolicyVersion: 2, Restored: &restored,
		}},
		{"commit-first", "commit", Commit{
			Deployment: "lnurl-prod", Epoch: 1, OperationID: operation, ExpectedSequence: 0, Head: head(1, 1, nil),
		}},
		{"commit-next", "commit", Commit{
			Deployment: "lnurl-prod", Epoch: 3, OperationID: operation, ExpectedSequence: 7, PriorDigest: &prior, Head: restored,
		}},
		{"statement-empty", "statement", Statement{
			AuthorityKeyID: "kms-1", Deployment: "lnurl-prod", CallerNonce: bytes.Repeat([]byte{0x5e}, 16),
			IssuedAtUnixMs: 1_790_000_000_000, ReleasePolicyVersion: 1,
		}},
		{"statement-full", "statement", Statement{
			AuthorityKeyID: "kms-1", Deployment: "lnurl-prod", CallerNonce: bytes.Repeat([]byte{0x5f}, 16),
			IssuedAtUnixMs: 1_790_000_000_001, ActiveEpoch: 3, ActiveWriterPublicKey: writer,
			ReleasePolicyVersion: 2, Sequence: 8, Head: &restored, CurrentOperationID: &operation,
		}},
	}
}

func encode(kind string, message any) ([]byte, error) {
	switch m := message.(type) {
	case Activate:
		return EncodeActivate(m)
	case Commit:
		return EncodeCommit(m)
	case Statement:
		return EncodeStatement(m)
	}
	panic("unknown message kind " + kind)
}

func decode(kind string, payload []byte) (any, error) {
	switch kind {
	case "activate":
		return DecodeActivate(payload)
	case "commit":
		return DecodeCommit(payload)
	case "statement":
		return DecodeStatement(payload)
	}
	panic("unknown message kind " + kind)
}

func unmarshal(t *testing.T, kind string, raw json.RawMessage) any {
	t.Helper()
	var err error
	var m any
	switch kind {
	case "activate":
		var v Activate
		err = json.Unmarshal(raw, &v)
		m = v
	case "commit":
		var v Commit
		err = json.Unmarshal(raw, &v)
		m = v
	case "statement":
		var v Statement
		err = json.Unmarshal(raw, &v)
		m = v
	}
	if err != nil {
		t.Fatalf("vector message: %v", err)
	}
	return m
}

func TestVectors(t *testing.T) {
	if *update {
		var out []vector
		for _, s := range samples() {
			payload, err := encode(s.kind, s.message)
			if err != nil {
				t.Fatalf("%s: %v", s.name, err)
			}
			message, _ := json.Marshal(s.message)
			out = append(out, vector{Name: s.name, Kind: s.kind, Message: message, Hex: hex.EncodeToString(payload)})
		}
		data, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(vectorsPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	data, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var vectors []vector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) != len(samples()) {
		t.Fatalf("%d vectors on disk, %d samples", len(vectors), len(samples()))
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			payload, err := encode(v.Kind, unmarshal(t, v.Kind, v.Message))
			if err != nil {
				t.Fatal(err)
			}
			if got := hex.EncodeToString(payload); got != v.Hex {
				t.Fatalf("encoding drifted\n got %s\nwant %s", got, v.Hex)
			}
			back, err := decode(v.Kind, payload)
			if err != nil {
				t.Fatal(err)
			}
			if got, _ := json.Marshal(back); !jsonEqual(t, got, v.Message) {
				t.Fatalf("decoding drifted\n got %s\nwant %s", got, v.Message)
			}
		})
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		t.Fatal("unparseable JSON")
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return bytes.Equal(ja, jb)
}

func TestLengthPrefixesKeepFieldsApart(t *testing.T) {
	a, _ := EncodeActivate(Activate{Deployment: "ab", ChallengeID: "c"})
	b, _ := EncodeActivate(Activate{Deployment: "a", ChallengeID: "bc"})
	if bytes.Equal(a, b) {
		t.Fatal(`"ab"+"c" and "a"+"bc" encode identically`)
	}
}

func TestRefusesIntegersTypeScriptCannotHold(t *testing.T) {
	if _, err := EncodeCommit(Commit{Epoch: MaxSafeInteger + 1, Head: head(1, 1, nil)}); err == nil {
		t.Fatal("encoded an epoch above 2^53-1")
	}
	payload, err := EncodeCommit(Commit{Epoch: MaxSafeInteger, Head: head(1, 1, nil)})
	if err != nil {
		t.Fatal(err)
	}
	max := []byte{0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	at := bytes.Index(payload, max)
	if at < 0 {
		t.Fatal("epoch not found in payload")
	}
	copy(payload[at:], []byte{0x00, 0x20, 0, 0, 0, 0, 0, 0})
	if _, err := DecodeCommit(payload); err == nil {
		t.Fatal("decoded an epoch above 2^53-1")
	}
}

func TestRefusesTruncatedOrTrailingPayloads(t *testing.T) {
	payload, err := EncodeCommit(Commit{Deployment: "lnurl-prod", Epoch: 1, Head: head(1, 1, nil)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCommit(payload[:len(payload)-1]); err == nil {
		t.Fatal("decoded a truncated payload")
	}
	if _, err := DecodeCommit(append(append([]byte(nil), payload...), 0)); err == nil {
		t.Fatal("decoded a payload with trailing bytes")
	}
}

func TestRefusesAnotherMessagesPayload(t *testing.T) {
	payload, err := EncodeActivate(Activate{Deployment: "lnurl-prod"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCommit(payload); err == nil {
		t.Fatal("an activation decoded as a commit")
	}
}

func TestRefusesAHeadWhoseKeyNamesAnotherObject(t *testing.T) {
	h := head(1, 1, nil)
	h.Key = "lnurl/db/" + repeat("ee", 32) + ".sqlite.br.enc"
	if _, err := EncodeCommit(Commit{Head: h}); err == nil {
		t.Fatal("encoded a head whose key names another object")
	}
}

func TestRefusesTextOutsidePrintableASCII(t *testing.T) {
	for _, deployment := range []string{"lnurl-ü", "lnurl\n", "lnurl\x7f"} {
		if _, err := EncodeActivate(Activate{Deployment: deployment}); err == nil {
			t.Fatalf("encoded deployment %q", deployment)
		}
	}
}

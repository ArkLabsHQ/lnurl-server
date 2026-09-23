package adopt

import (
	"strings"
	"testing"
)

const ciphertext = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

// As src/enclave/checkpoint.ts writes HEAD.json without an authority.
func headJSON(overrides ...string) []byte {
	fields := map[string]string{
		"schema": `"lnurl.enclave.checkpoint.v2"`, "prefix": `"lnurl/db"`, "sequence": "7", "size": "4096",
		"digest": `"` + strings.Repeat("d4", 32) + `"`, "ciphertextDigest": `"` + ciphertext + `"`,
		"key": `"lnurl/db/` + ciphertext + `.sqlite.br.enc"`, "schemaVersion": "12", "epoch": "0",
		"previousDigest": `"` + strings.Repeat("b2", 32) + `"`,
	}
	for i := 0; i+1 < len(overrides); i += 2 {
		fields[overrides[i]] = overrides[i+1]
	}
	parts := make([]string, 0, len(fields))
	for k, v := range fields {
		parts = append(parts, `"`+k+`":`+v)
	}
	return []byte("{" + strings.Join(parts, ",") + "}")
}

func TestAdoptsAPreAuthorityHeadAtItsSealingEpoch(t *testing.T) {
	head, err := Head(headJSON(), "lnurl/db")
	if err != nil {
		t.Fatal(err)
	}
	if head.Sequence != 7 || head.SealEpoch != 0 || head.CiphertextDigest != ciphertext || head.SchemaVersion != 12 || *head.PreviousDigest != strings.Repeat("b2", 32) {
		t.Fatalf("adopted %+v", head)
	}
	if first, err := Head(headJSON("previousDigest", "null", "sequence", "1"), "lnurl/db"); err != nil || first.PreviousDigest != nil {
		t.Fatalf("a first head adopted as %+v, %v", first, err)
	}
}

func TestRefusesWhatIsNotAPreAuthorityChain(t *testing.T) {
	for name, data := range map[string][]byte{
		"an authority-era hint": headJSON("authoritative", "false"),
		"another prefix":        headJSON("prefix", `"tenant-b/db"`),
		"a key naming another":  headJSON("key", `"lnurl/db/`+strings.Repeat("ee", 32)+`.sqlite.br.enc"`),
		"another schema":        headJSON("schema", `"lnurl.enclave.checkpoint.v1"`),
		"sequence zero":         headJSON("sequence", "0"),
		"an uppercase digest":   headJSON("digest", `"`+strings.Repeat("D4", 32)+`"`),
		"past 2^53":             headJSON("epoch", "9007199254740992"),
		"not JSON":              []byte("{"),
	} {
		if _, err := Head(data, "lnurl/db"); err == nil {
			t.Errorf("%s: adopted", name)
		}
	}
}

package main

import (
	"os/exec"
	"strings"
	"testing"
)

// The in-memory store, the shared test suite and the devserver can each accept a
// writer or sign a statement without KMS or DynamoDB; none may link into production.
func TestProductionBinaryLinksNoTestHelpers(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	deps := string(out)
	if !strings.Contains(deps, "/authority/internal/store/dynamo\n") {
		t.Fatal("go list did not report the production store; the check would prove nothing")
	}
	for _, forbidden := range []string{"/internal/store/memory", "/internal/state/storetest", "/cmd/devserver"} {
		if strings.Contains(deps, "github.com/ArkLabsHQ/lnurl-server/authority"+forbidden) {
			t.Errorf("the production binary links %s", forbidden)
		}
	}
}

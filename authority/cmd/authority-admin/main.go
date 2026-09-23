// Command authority-admin is the security-account operator's tool. It creates a
// deployment's record, optionally adopting the HEAD.json a pre-authority enclave wrote,
// records which measurements may write, and shows a record. It runs with the
// operator's own credentials; nothing an enclave can reach calls any of it.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/adopt"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/store/dynamo"
)

const usage = `usage:
  authority-admin create  -table T -deployment D [-prefix lnurl/db] [-policy 1] [-adopt HEAD.json]
  authority-admin approve -table T -deployment D -pcr0 HEX -pcr1 HEX -pcr2 HEX -policy N
  authority-admin show    -table T -deployment D`

func main() {
	if len(os.Args) < 2 {
		fail(usage)
	}
	flags := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	table := flags.String("table", "", "the authority's DynamoDB table")
	deployment := flags.String("deployment", "", "the deployment, as ENCLAVE_DEPLOYMENT names it")
	prefix := flags.String("prefix", "lnurl/db", "the deployment's checkpoint prefix")
	policy := flags.Uint("policy", 1, "release-policy version")
	adoptFrom := flags.String("adopt", "", "a pre-authority HEAD.json to make the first committed checkpoint")
	pcr0 := flags.String("pcr0", "", "approved PCR0, lowercase hex")
	pcr1 := flags.String("pcr1", "", "approved PCR1, lowercase hex")
	pcr2 := flags.String("pcr2", "", "approved PCR2, lowercase hex")
	_ = flags.Parse(os.Args[2:])
	if *table == "" || *deployment == "" {
		fail(usage)
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		fail(err.Error())
	}
	store := dynamo.New(dynamodb.NewFromConfig(cfg), *table)
	switch os.Args[1] {
	case "create":
		record := state.Record{Deployment: *deployment, Prefix: *prefix, ReleasePolicyVersion: uint32(*policy)}
		if *adoptFrom != "" {
			data, err := os.ReadFile(*adoptFrom)
			if err != nil {
				fail(err.Error())
			}
			head, err := adopt.Head(data, *prefix)
			if err != nil {
				fail(err.Error())
			}
			record.Checkpoint, record.Sequence = &head, head.Sequence
		}
		if err := store.Create(ctx, record); err != nil {
			fail(err.Error())
		}
	case "approve":
		if err := store.Approve(ctx, *deployment, [3]string{*pcr0, *pcr1, *pcr2}, uint32(*policy)); err != nil {
			fail(err.Error())
		}
	case "show":
		record, err := store.Get(ctx, *deployment)
		if err != nil {
			fail(err.Error())
		}
		out := json.NewEncoder(os.Stdout)
		out.SetIndent("", "  ")
		_ = out.Encode(record)
	default:
		fail(usage)
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(2)
}

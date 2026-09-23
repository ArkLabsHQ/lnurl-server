package dynamo

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state/storetest"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/wire"
)

var tables atomic.Int64

// openStore gives each caller its own table on the DynamoDB Local at DYNAMODB_ENDPOINT.
func openStore(t *testing.T) *Store {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("DYNAMODB_ENDPOINT is unset in CI, where the DynamoDB suite must run")
		}
		t.Skip("set DYNAMODB_ENDPOINT to a DynamoDB Local to run the DynamoDB suite")
	}
	client := dynamodb.NewFromConfig(aws.Config{
		Region: "us-east-1", Credentials: credentials.NewStaticCredentialsProvider("local", "local", ""),
		BaseEndpoint: aws.String(endpoint),
	})
	table := fmt.Sprintf("authority-%d-%d", time.Now().UnixNano(), tables.Add(1))
	_, err := client.CreateTable(context.Background(), &dynamodb.CreateTableInput{
		TableName: aws.String(table), BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	})
	return New(client, table)
}

func TestTransitions(t *testing.T) {
	storetest.Run(t, func(t *testing.T) state.Store { return openStore(t) })
}

func TestApprovalsAreTheOperatorsRecords(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	pcrs := [3]string{strings.Repeat("0a", 48), strings.Repeat("0b", 48), strings.Repeat("0c", 48)}
	if _, ok, err := s.Approved(ctx, "lnurl-test", pcrs); err != nil || ok {
		t.Fatalf("unapproved measurements answered %v %v", ok, err)
	}
	if err := s.Approve(ctx, "lnurl-test", pcrs, 3); err != nil {
		t.Fatal(err)
	}
	if policy, ok, err := s.Approved(ctx, "lnurl-test", pcrs); err != nil || !ok || policy != 3 {
		t.Fatalf("approved measurements answered %d %v %v", policy, ok, err)
	}
	if _, ok, _ := s.Approved(ctx, "another", pcrs); ok {
		t.Fatal("an approval crossed deployments")
	}
	if err := s.Approve(ctx, "lnurl-test", [3]string{strings.ToUpper(pcrs[0]), pcrs[1], pcrs[2]}, 1); err == nil {
		t.Fatal("approved a measurement that attestation could never report")
	}
}

func TestRecordsSurviveTheRoundTrip(t *testing.T) {
	previous, ciphertext := strings.Repeat("b2", 32), strings.Repeat("c3", 32)
	full := state.Record{
		Deployment: "lnurl-test", Prefix: "lnurl/db", Epoch: 3, Sequence: 8, ReleasePolicyVersion: 2,
		Writer:             &state.Writer{PublicKey: bytes.Repeat([]byte{0xe7}, 32), PCRs: [3]string{"p0", "p1", "p2"}, ActivatedAtMs: 5, QuoteSHA256: "q"},
		CurrentOperationID: strings.Repeat("0f", 16),
		Checkpoint: &wire.Head{
			Schema: state.HeadSchema, Prefix: "lnurl/db", SchemaVersion: 12, SealEpoch: 3, Sequence: 8, PreviousDigest: &previous,
			Digest: strings.Repeat("d4", 32), Size: 4096, CiphertextDigest: ciphertext, Key: "lnurl/db/" + ciphertext + ".sqlite.br.enc",
		},
		PendingChallenge: &state.Challenge{ID: "ch", Nonce: []byte{1, 2}, ExpiresAtMs: 9},
		RecordVersion:    7, UpdatedAtMs: 11,
	}
	for _, r := range []state.Record{full, {Deployment: "lnurl-test", Prefix: "lnurl/db"}} {
		back, err := decodeRecord(encodeRecord(r))
		if err != nil || !reflect.DeepEqual(*back, r) {
			t.Fatalf("round trip gave %+v, %v", back, err)
		}
	}
	if _, err := decodeRecord(map[string]types.AttributeValue{"deployment": num(1)}); err == nil {
		t.Fatal("decoded a mistyped record")
	}
}

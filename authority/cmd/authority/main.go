// Command authority serves the checkpoint authority: DynamoDB for records and the
// operator's approvals, KMS for the statement key, and the production attestation
// verifier. It speaks plain HTTP; TLS terminates in front of it.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kms"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/attest"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/httpapi"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/sign"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/store/dynamo"
)

func required(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("%s is required", name)
	}
	return v
}

func main() {
	table, keyID := required("AUTHORITY_TABLE"), required("AUTHORITY_KMS_KEY_ID")
	listen := os.Getenv("AUTHORITY_LISTEN")
	if listen == "" {
		listen = ":8080"
	}
	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatal(err)
	}
	store := dynamo.New(dynamodb.NewFromConfig(cfg), table)
	signer := sign.NewKMS(kms.NewFromConfig(cfg), keyID)
	spki, err := signer.PublicKey(ctx)
	if err != nil {
		log.Fatalf("statement key: %v", err)
	}
	log.Printf("authority on %s, statement key %s", listen, sign.KeyID(spki))
	server := &httpapi.Server{
		Authority: &state.Authority{Store: store, Quotes: attest.New(), Approvals: store, Now: time.Now, ChallengeTTL: time.Minute},
		Signer:    signer, Now: time.Now,
	}
	log.Fatal((&http.Server{
		Addr: listen, Handler: server.Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second,
	}).ListenAndServe())
}

// Command devserver runs the authority over an in-memory store with a throwaway key,
// for the cross-language tests. It cannot activate a writer: activation goes through
// the production verifier and nothing is approved, so a writer can only be seeded.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/ArkLabsHQ/lnurl-server/authority/internal/attest"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/httpapi"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/state"
	"github.com/ArkLabsHQ/lnurl-server/authority/internal/store/memory"
)

type localSigner struct{ key *ecdsa.PrivateKey }

func (s localSigner) PublicKey(context.Context) ([]byte, error) {
	return x509.MarshalPKIXPublicKey(&s.key.PublicKey)
}

func (s localSigner) Sign(_ context.Context, payload []byte) ([]byte, error) {
	digest := sha256.Sum256(payload)
	return ecdsa.SignASN1(rand.Reader, s.key, digest[:])
}

type noApprovals struct{}

func (noApprovals) Approved(context.Context, string, [3]string) (uint32, bool, error) {
	return 0, false, nil
}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "address to serve on")
	deployment := flag.String("deployment", "lnurl-dev", "the one deployment this server knows")
	prefix := flag.String("prefix", "lnurl/db", "that deployment's checkpoint prefix")
	writer := flag.String("seed-writer", "", "hex Ed25519 public key to install as the active writer")
	epoch := flag.Uint64("seed-epoch", 1, "the epoch the seeded writer holds")
	flag.Parse()

	store := memory.New()
	record := state.Record{Deployment: *deployment, Prefix: *prefix, ReleasePolicyVersion: 1}
	if *writer != "" {
		key, err := hex.DecodeString(*writer)
		if err != nil || len(key) != 32 {
			log.Fatal("seed-writer must be 32 bytes of hex")
		}
		record.Epoch, record.Writer = *epoch, &state.Writer{PublicKey: key}
	}
	if err := store.Create(context.Background(), record); err != nil {
		log.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	signer := localSigner{key}
	spki, _ := signer.PublicKey(context.Background())
	server := &httpapi.Server{
		Authority: &state.Authority{Store: store, Quotes: attest.New(), Approvals: noApprovals{}, Now: time.Now, ChallengeTTL: time.Minute},
		Signer:    signer, Now: time.Now,
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{
		"url": "http://" + ln.Addr().String(), "spki": base64.StdEncoding.EncodeToString(spki),
	}); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", server.Handler())
	// Stands a random successor up through the store's own conditional activation, as
	// a real one would land, so tests can watch the seeded writer be fenced.
	mux.HandleFunc("POST /dev/fence", func(w http.ResponseWriter, r *http.Request) {
		if err := fence(r.Context(), store, *deployment); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	log.Fatal(http.Serve(ln, mux))
}

func fence(ctx context.Context, store *memory.Store, deployment string) error {
	rec, err := store.Get(ctx, deployment)
	if err != nil {
		return err
	}
	now := uint64(time.Now().UnixMilli())
	challenge := state.Challenge{ID: "dev-fence", Nonce: []byte{0}, ExpiresAtMs: now + 60_000}
	if err := store.PutChallenge(ctx, deployment, challenge, now); err != nil {
		return err
	}
	successor := make([]byte, 32)
	if _, err := rand.Read(successor); err != nil {
		return err
	}
	_, err = store.Activate(ctx, state.Activation{
		Deployment: deployment, ExpectedEpoch: rec.Epoch, ChallengeID: challenge.ID, NowMs: now,
		ReleasePolicyVersion: rec.ReleasePolicyVersion, Restored: rec.Checkpoint, Writer: state.Writer{PublicKey: successor},
	})
	return err
}

# Enclave Research Build

This packages LNURL for Nitro. It is **not a host-tamper-resistant deployment** yet. Do not enroll real users or put funds or production secrets in this research profile.

The default profile deliberately uses `lnurl.invalid`, an in-memory application database and no managed application secrets. Existing Docker deployments are unchanged.

What is here is the packaging and its reproducibility evidence, plus durable state that seals SQLite snapshots into S3. **The durable-state half has not yet run against real S3 or on Nitro.** The checkpoint authority that stops a host replaying an older snapshot is built but cannot run yet, because activating a writer needs an attestation helper that must first be validated on Nitro. And the key that seals its snapshots has no safe source inside an enclave. See Durable State. Signed owner setup, protected payment proofs, client verification and approved key release are likewise not implemented; `src/enclave/owner-setup.ts` is a proposed encoding that binds the design's full field list, but no route reads it and nothing yet stores or enforces a signed setup.

## Build

Use a clean Linux checkout of the committed revision, Nix 2.34.7 and the committed lockfiles. The supported target is `x86_64-linux`.

```sh
nix build .#app --no-update-lock-file --out-link result-app
nix build .#eif --no-update-lock-file --out-link result-eif
nix develop --no-update-lock-file --command node scripts/enclave-smoke.mjs ./result-app
nix build .#app .#eif --no-update-lock-file --no-link --rebuild
```

`result-eif` contains `image.eif` and `pcr.json`. These commands build outside AWS; they do not boot Nitro, validate an AWS quote, establish durable state or approve a release.

The flake pins Enclave at `3c33a40ef4a2a49297ab5df5163945fa9e50e544`, including its image builder, kernel and runtime dependencies. Nixpkgs supplies Node 22.23.1; pnpm is fixed at 10.25.0. The dependency archive has a computed fixed-output hash, and installation/build runs offline after fetching. The application source filter excludes databases, environment files, previous `dist`, local dependencies and unrelated workspace content. Use a clean Git checkout rather than a `path:` flake containing private files: Nix imports flake inputs into its store before the application filter runs.

The static native launcher uses absolute Node/application paths and a freshly constructed environment from `nix/profile.json`. Interpreter, loader and shell variables inherited from the parent are not forwarded. The public and admin bind addresses are loopback; ordinary deployments can opt into `PUBLIC_BIND` without changing their default listener behavior. Startup tests inject hostile `NODE_OPTIONS`, loader variables and database settings, then exercise packaged HTTP, SSE and SQLite.

`nix/profile.json` is public and measured. Changes to it change the expected image measurements. It is not a place for credentials or private user data. Build metadata uses a fixed epoch; runtime randomness is not seeded or frozen.

## Reproducibility Evidence

The `enclave-reproducibility` workflow uses two fresh Linux jobs. Application and EIF derivations prohibit substitution, so a downloaded application/EIF is not counted as a rebuild. Hash-verified dependencies may use Nix caches. The workflow compares the unsigned EIF bytes, PCR0/PCR1/PCR2, complete application closure, filtered source and lock/profile hashes. Its artifacts retain the public profile, locks, image, measurements and manifests.

```sh
node scripts/enclave-artifacts.mjs compare first/manifest.json second/manifest.json
```

The comparison rejects missing evidence, zero debug measurements, different inputs/outputs and reuse of the same builder identifier. Distinct identifiers alone do not prove independent builders: inspect the trusted workflow/provenance. A successful same-machine `--rebuild` is useful but is not the two-builder gate. This is reproducibility from pinned npm packages, not a claim that every dependency was rebuilt from its original upstream source.

The gate runs, and passes: two independent runners have produced byte-identical unsigned EIFs and identical PCR0/PCR1/PCR2 on every commit of this branch. The compare job prints the agreed measurement to its step summary, so it is readable from the run page rather than only from a downloaded artifact. PCR1 stays fixed across application changes, as the kernel measurement should; PCR0 and PCR2 move with the application.

There is no enclave promotion or approval job. Before any protected release, the independent security administrator must approve the measured source/profile after both rebuilds and runtime/security tests. Publish the signed approval manifest separately. An unsigned build manifest, image signature certificate or host-provided PCR value is not a trust root. Existing Docker release jobs are not changed by this research gate.

## Durable State

> **Not yet exercised against real S3 or on Nitro.** Snapshots go to an S3 bucket through the AWS SDK, reached with the instance role through Enclave's IMDS forwarder: the runtime advertises it as `AWS_EC2_METADATA_SERVICE_ENDPOINT`, and the application inherits that. Tests run the real SDK against a local S3 stand-in, and the packaged image was checked to load the SDK on its own Node. This is the design's LNURL-owned adapter. An earlier version targeted a `/v1/storage` runtime API that Enclave never had; [ArkLabsHQ/enclave#195](https://github.com/ArkLabsHQ/enclave/issues/195) asks for one as an optional convenience, not a prerequisite.
>
> Snapshots are sealed with AES-256-GCM under `ENCLAVE_STORAGE_KEY`, with every head field bound as associated data. So a host holding storage cannot read a snapshot, edit one, or fabricate a database behind a head that agrees with it — each fails authentication on restore. What it can still do is **replay an older snapshot that was genuinely sealed**, since every one of those authenticates. That is the rollback problem, and it is what the checkpoint authority closes (see Checkpoint Authority below); without one, only the manual pins stand in its way.
>
> Two gaps remain. **The key has no safe source yet.** Read from the environment, it is exactly as trustworthy as the environment, which inside Enclave the host can write through the SSM overlay (#194) — so a host that supplies or reads the key defeats all of the above. The seal is only as good as a key released solely to the attested enclave. And without an authority, **restore still trusts the stored `HEAD.json`** to say which snapshot is current; under one, the authority names it and `HEAD.json` is never read.

Nitro gives the workload no persistent disk, so SQLite runs on the enclave's RAM-backed filesystem and durability has to come from snapshots held somewhere outside it. `ENCLAVE_CHECKPOINT=1` turns this on. It is off by default, and nothing below changes an ordinary deployment.

| Variable | Meaning |
| --- | --- |
| `ENCLAVE_CHECKPOINT` | `1` enables checkpointing, and defaults `DB_PATH` to `/run/lnurl/state.sqlite`. |
| `ENCLAVE_S3_BUCKET` | Bucket holding this deployment's sealed snapshots and head. Required when enabled. Access comes from the instance role, which the host controls — so the host can withhold or delete objects, but not read or forge them. |
| `ENCLAVE_AWS_REGION` | The bucket's region, default `us-east-1`. The same variable and default the runtime uses, so the two agree. |
| `ENCLAVE_CHECKPOINT_KEY` | Object prefix for this deployment, default `lnurl/db`. Traversal is rejected at config load. |
| `ENCLAVE_CHECKPOINT_INTERVAL_MS` | Background cadence, default `5000`, minimum `100`. |
| `ENCLAVE_CHECKPOINT_ALLOW_GENESIS` | `1` permits a first boot with no prior head. Initial deployment only. |
| `ENCLAVE_CHECKPOINT_HEAD` | The ciphertext digest of the snapshot the security administrator says is current. Refused alongside an authority, which names the head itself. |
| `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` | Lowest head sequence this deployment will restore from. |
| `ENCLAVE_STORAGE_KEY` | 32-byte key sealing every snapshot, hex or base64. Required when enabled, and must differ from `TOKEN_ENCRYPTION_KEY`. See the key-source caveat above. |
| `ENCLAVE_DEPLOYMENT` | Deployment identity bound into every seal, so a snapshot cannot be restored into another deployment. Required when enabled. Inside Enclave it comes from the measured profile and the SSM overlay cannot override it. |
| `ENCLAVE_AUTHORITY_URL` | The checkpoint authority. With the keys below, it becomes the only source of the current head. |
| `ENCLAVE_AUTHORITY_PUBLIC_KEYS` | Base64 SPKI P-256 keys the authority may sign statements with: one, or two during a rotation. Required with the URL, and refused without it. |
| `ENCLAVE_AUTHORITY_TIMEOUT_MS` | Per request, default `10000`. |
| `ENCLAVE_AUTHORITY_SKEW_MS` | How far a statement's timestamp may sit from the enclave's clock, default `300000`. The nonce, not the clock, is what carries freshness. |
| `ENCLAVE_RELEASE_POLICY_VERSION` | The release this image belongs to, default `1`. Fixed before the build, so the operator approves exactly these measurements at exactly this version. |

Snapshots are taken with `VACUUM INTO`, not `DatabaseSync.serialize`: the pinned Node 22.23.1 has neither `serialize` nor `deserialize` nor `backup` on `node:sqlite`, so anything built on those works only on a newer Node than this image ships. `VACUUM INTO` is byte-stable for unchanged content, so an idle deployment re-advertises its existing head instead of uploading the database again. It stages a full copy in `scratchDir` — the directory holding `DB_PATH` — so budget the database size twice over in enclave memory at checkpoint time.

Boot restores before opening the database: the snapshot is fetched by the exact key the head names, checked against its digest and size, written to `DB_PATH`, and only then opened. Stale `-wal`/`-shm` sidecars are removed first, because a journal belonging to a different image would otherwise be replayed into this one. Restore therefore needs a file-backed `DB_PATH`; `:memory:` is refused. A missing head aborts the boot unless genesis is explicitly allowed, and the state directory is created because the enclave's filesystem starts empty.

An accepted offline swap is committed and then checkpointed before the payer is handed the invoice. A checkpoint that cannot be written fails that request instead of answering with an invoice whose preimage a restart would forget.

A covenant destination takes the same barrier before its address is returned. Its preimage is random and kept only in the contract registered at derivation, and every spend path — the user's recovery leaves included — needs the taproot tree that preimage fixes, so a restart that forgot the contract would strand whatever the payer sent. A checkpoint that cannot be written fails the request, as for a swap, rather than falling back to the static address.

The settlement pass takes the same barrier after a claim it actually made, and stops the pass if that barrier fails rather than claiming another lockup on top of an unrecorded one. Claims are fenced because they move funds and the txid credited to the recipient does not come back; marking a swap settled without having claimed it only records what the solver already did, so repeating that after a restart costs nothing and is left unfenced. For the same reason the pass starts no claim at all while the checkpoint store reports it cannot commit, and keeps checking status meanwhile.

Everything else is held at the response. Both HTTP apps hold each buffered response until nothing the database connection has written is uncommitted — the request's own writes, another request's, or a background worker's — so a setup change, a registration or an admin edit is acknowledged only once durable, and no reader, verify included, is shown state a restart could take back. The watermark is SQLite's `total_changes()` on the one connection everything shares, the SDK's contract tables included. A barrier returns at once when nothing has changed since the last committed snapshot, so a clean database costs a response nothing, and concurrent responses share checkpoints rather than taking one each. Health probes are exempt. A response whose headers are already out cannot be held — the wallet's event stream, static files — so an event-stream notification can run ahead of the commit behind it. A commit that fails answers 503 with an LNURL-shaped error body.

A refused write is not undone. After a transient failure it stays in the enclave's database and lands with the next checkpoint that succeeds, so a client refused this way should re-read before retrying; no identifier changes that. The other half of the ambiguity is settled under a checkpoint authority. Every commit carries an operation identifier, so a commit whose answer was lost is reconciled against the authority's state instead of being committed twice. And a writer the authority refuses for good stops, leaving a restart to restore what the authority committed.

`persistenceCheckpoint` is a required health check, so a failed checkpoint — or silence, meaning no commit within six intervals floored at 30 seconds — reports the server unready and should take it out of rotation. Silence is tracked separately from failure because a store that has stopped attempting would otherwise keep answering with its last success. Storage requests time out after 30 seconds instead of hanging: the store coalesces onto a request already in flight, so one stuck call would stall every later flush and every caller waiting on a barrier.

### Tested capacity

Measured on the pinned Node 22.23.1 under Linux, seeding accepted offline swaps as the dominant row and checkpointing to a loopback HTTP endpoint rather than real S3, so real storage adds its network round trips on top. "Barrier" is the wait for one further accepted swap to become durable — what a payer actually sits behind. These are single runs, and the small-database figures in particular vary several-fold between runs. Encryption was measured on its own for that reason: AES-256-GCM over the compressed object has a median cost of 0.09 ms at 1k swaps and 5.8 ms at 200k across 25 runs, so it sits well inside that variance. It is cheap because it runs after compression, on the small object.

| Accepted swaps | Database | Stored object | Barrier |
| --- | --- | --- | --- |
| 1,000 | 1.3 MB | 0.1 MB | 17 ms |
| 10,000 | 13.3 MB | 0.5 MB | 54 ms |
| 50,000 | 66.0 MB | 2.7 MB | 298 ms |
| 200,000 | 264.3 MB | 10.6 MB | 1.1 s |

About 1.3 KB of database per accepted swap. Snapshots are brotli-compressed before upload — around 25x on this shape of data, because SQLite pages of hex identifiers compress extremely well. Quality 1 was both the fastest to encode and the smallest of the codecs measured, so nothing is traded for it. Transfer was over half of an uncompressed barrier even on loopback; against real storage the reduction matters more than these figures show.

The head's `digest` and `size` describe the **plaintext** image, so a snapshot's identity does not depend on the codec. A stored object is decompressed under a limit taken from that `size`, which stops a small object expanding without bound. Because `size` is part of the associated data, it is authenticated before decompression runs, so the host cannot choose it either.

Compression lowers the constant; it does not change the shape. **A barrier still snapshots the whole database, not the change**, so the wait for any response that follows a write — an invoice, a covenant address, an acknowledged setup change — remains proportional to total history rather than to current activity. Settlement rows carrying an `address_id` are never reclaimed — they are the owner's history and the only copy of it — so that total only grows. At the volumes above it is comfortable. A deployment expecting sustained traffic needs a retention or archival answer, or checkpoints that ship deltas rather than the whole image, before the barrier becomes the slowest part of a receive.

### Rollback

Nothing in a head reveals a rollback. Every head is internally consistent at every sequence, so a host that retains old snapshots can re-advertise one and the enclave cannot tell from the object alone. Unpinned, that replay is accepted. Two out-of-band pins guard it, and they suit different restarts:

- `ENCLAVE_CHECKPOINT_HEAD` names one exact ciphertext digest, so it only fits a **controlled** restart: flush on shutdown, record the final digest, boot against it. The digest changes on every flush, so a pin set in advance is stale within seconds and a crash would leave the enclave unable to boot at all.
- `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` names a floor instead, which is what survives a **crash**, where nobody outside the enclave knows which digest the timer wrote last. It blocks any replay below the floor while accepting whatever the enclave legitimately reached above it.

Both are manual stand-ins for the checkpoint authority below, which names the head itself. Without one, an operator advances these by hand, and a replay between the floor and the true head is still accepted.

Two enclaves sharing one `ENCLAVE_CHECKPOINT_KEY` would each extend their own chain, and whichever wrote `HEAD.json` last would erase the other's history. Without an authority, a writer re-reads the stored head before committing and refuses if it is not the head it last wrote. So a second enclave started on a live prefix stops at its first checkpoint, a writer whose head moved underneath it stops too, and both then read unready. That is detection, with the window between the read and the write still open. Under an authority it is exclusion: a successor's activation increments the epoch, and every commit is conditional on it.

### Checkpoint Authority

`authority/` is the design's independent checkpoint authority: a small Go service over one DynamoDB table, meant for a separate security account. It keeps one bounded record per deployment: the committed checkpoint, the active writer's epoch and per-boot key, and the release policy. Every transition is one conditional write, and every read is strongly consistent. Setting `ENCLAVE_AUTHORITY_URL` and `ENCLAVE_AUTHORITY_PUBLIC_KEYS` makes it the only source of the current head:

- **Boot** generates a per-boot Ed25519 writer key and reads a statement signed by a pinned key and echoing a fresh nonce. It restores exactly the checkpoint that statement names, never reading `HEAD.json`, then activates on that checkpoint with a Nitro quote over the activation. Activation is conditional on the exact checkpoint restored and increments the writer epoch, which fences any predecessor atomically. If the head moves in between, the boot restores the new one and tries again.
- **Every checkpoint** is sealed under the granted epoch and committed conditionally on the epoch, the writer key, the expected sequence and the prior digest. A lost answer is reconciled through the commit's operation identifier. A refusal, or finding another writer, stops the writer for good: the process exits, and a restart restores what the authority committed.
- **An authority outage** blocks commits, so buffered responses answer 503, health reads unready and no claim starts until it returns. An unknown deployment is fatal and never read as genesis.

The operator runs `authority-admin` with the security account's credentials. `create` makes a deployment's record, and `-adopt HEAD.json` makes an existing pre-authority chain's head its first committed checkpoint. That asserts, once, what `ENCLAVE_CHECKPOINT_HEAD` asserts on every boot. `approve` records which PCR0, PCR1 and PCR2 may write, and at which release-policy version; an image carries its version in `ENCLAVE_RELEASE_POLICY_VERSION`, and activation never moves the version backwards.

What cannot be claimed yet:

- **Nothing produces the quote.** Activation needs a Nitro attestation over the activation payload, from a helper that must first be validated on real Nitro. Until it exists, authority mode refuses to boot with a named error rather than fall back to `HEAD.json`. The authority's check of our binding has only met documents minted under a test root, though its chain verification passes a genuine AWS document end to end.
- **The pinned key inherits #194.** The authority's public keys belong in the measured profile, where the launcher's baked environment is what protects them; #194 is the ability to start something other than the launcher.
- **No deployment exists**: no table, no KMS key, no network path. That waits for the security account's operator.

## Security Blockers

The pinned runtime allows its SSM overlay to replace `APP_BINARY_NAME` and passes broad environment values to the selected child. A local reproduction against that exact source confirmed the application launcher can be bypassed. Filed upstream as [ArkLabsHQ/enclave#194](https://github.com/ArkLabsHQ/enclave/issues/194). The native LNURL launcher only protects launches that actually reach it. Reproducible PCRs do not cure mutable post-measurement execution. This must be fixed upstream or prevented by independently governed, verified deployment controls before protecting user data.

The runtime also starts automatic successor handoff before the application and does not enforce this application's independent release approval policy; that is covered in the same upstream issue. Do not entrust application storage keys to that managed-secret migration path. An independently governed, attested application-key release path is required unless upstream handoff gains the necessary approval check. Such a key service cannot repair the launcher bypass by itself.

Keep the Enclave dependency unchanged until a reviewed resolution is available. The remaining runtime gate requires a Nitro-capable test instance: real HTTP/SSE, production quote verification, application-key binding, persistence failure injection, protected offline receive/recovery and an approved upgrade. Local smoke tests and browser compilation cannot replace those gates.

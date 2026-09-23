# Enclave Research Build

This packages LNURL for Nitro. It is **not a host-tamper-resistant deployment** yet. Do not enroll real users or put funds or production secrets in this research profile.

The default profile deliberately uses `lnurl.invalid`, an in-memory application database and no managed application secrets. Existing Docker deployments are unchanged.

What is here is the packaging and its reproducibility evidence. **The durable-state half is a design, not a working feature** — it targets an application storage API Enclave does not have, so it cannot run at all today, and its snapshots are not yet encrypted. See Durable State. Signed owner setup, protected payment proofs, client verification and approved key release are likewise not implemented; `src/enclave/owner-setup.ts` is a proposed encoding that no route reads, and it does not yet carry every field the setup must bind — notably the owner key and the Arkade destination.

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

> **This does not run against Enclave today.** It is written against an application-facing key/value API at `/v1/storage` that the pinned runtime does not have. At `3c33a40` — which is also `origin/master` — the internal surface is `GET /health` and `POST /v1/metrics`, `/v1/logs`, `/v1/traces`, and `ENCLAVE_RUNTIME_TOKEN` authenticates telemetry ingest, not storage. With `ENCLAVE_CHECKPOINT=1` the first checkpoint takes a 404 and the server refuses to start, which is fail-closed but not functional.
>
> The intended path does not depend on Enclave growing that API. The design this implements calls for an **LNURL-owned S3 adapter**, in-enclave authenticated encryption of each snapshot under a separate storage key, and an independent checkpoint authority that pins which object is current. [ArkLabsHQ/enclave#195](https://github.com/ArkLabsHQ/enclave/issues/195) asks for a runtime convenience API; it is optional, not a prerequisite. The `EnclaveStorage` interface is the seam an S3 adapter replaces.
>
> Two gaps against that design remain in this code. **Snapshots are not encrypted** — they are compressed, not sealed, so nothing here should be pointed at real storage yet. And **restore trusts the stored `HEAD.json`**, a head the host can choose, mitigated only by the manual pins below; the design has the authority, not the host, name the exact object to restore.

Nitro gives the workload no persistent disk, so SQLite runs on the enclave's RAM-backed filesystem and durability has to come from snapshots held somewhere outside it. `ENCLAVE_CHECKPOINT=1` turns this on. It is off by default, and nothing below changes an ordinary deployment.

| Variable | Meaning |
| --- | --- |
| `ENCLAVE_CHECKPOINT` | `1` enables checkpointing, and defaults `DB_PATH` to `/run/lnurl/state.sqlite`. |
| `ENCLAVE_RUNTIME_TOKEN` | Bearer token the runtime hands the application. Required when enabled. |
| `ENCLAVE_STORAGE_URL` | Storage base URL. Defaults to loopback on `ENCLAVE_PROXY_PORT`, the runtime's own internal listener, which is `8080` unless the runtime says otherwise. |
| `ENCLAVE_CHECKPOINT_KEY` | Object prefix for this deployment, default `lnurl/db`. Traversal is rejected at config load. |
| `ENCLAVE_CHECKPOINT_INTERVAL_MS` | Background cadence, default `5000`, minimum `100`. |
| `ENCLAVE_CHECKPOINT_ALLOW_GENESIS` | `1` permits a first boot with no prior head. Initial deployment only. |
| `ENCLAVE_CHECKPOINT_HEAD` | The snapshot digest the security administrator says is current. |
| `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` | Lowest head sequence this deployment will restore from. |

Snapshots are taken with `VACUUM INTO`, not `DatabaseSync.serialize`: the pinned Node 22.23.1 has neither `serialize` nor `deserialize` nor `backup` on `node:sqlite`, so anything built on those works only on a newer Node than this image ships. `VACUUM INTO` is byte-stable for unchanged content, so an idle deployment re-advertises its existing head instead of uploading the database again. It stages a full copy in `scratchDir` — the directory holding `DB_PATH` — so budget the database size twice over in enclave memory at checkpoint time.

Boot restores before opening the database: the snapshot is fetched by the exact key the head names, checked against its digest and size, written to `DB_PATH`, and only then opened. Stale `-wal`/`-shm` sidecars are removed first, because a journal belonging to a different image would otherwise be replayed into this one. Restore therefore needs a file-backed `DB_PATH`; `:memory:` is refused. A missing head aborts the boot unless genesis is explicitly allowed, and the state directory is created because the enclave's filesystem starts empty.

An accepted offline swap is committed and then checkpointed before the payer is handed the invoice. A checkpoint that cannot be written fails that request instead of answering with an invoice whose preimage a restart would forget.

The settlement pass takes the same barrier after a claim it actually made, and stops the pass if that barrier fails rather than claiming another lockup on top of an unrecorded one. Claims are fenced because they move funds and the txid credited to the recipient does not come back; marking a swap settled without having claimed it only records what the solver already did, so repeating that after a restart costs nothing and is left unfenced.

Everything else the server writes is covered more bluntly. `persistenceCheckpoint` is a required health check, so a failed checkpoint — or silence, meaning no commit within six intervals floored at 30 seconds — reports the server unready and should take it out of rotation rather than let it keep accepting state it cannot persist. Silence is tracked separately from failure because a store that has stopped attempting would otherwise keep answering with its last success. Storage requests time out after 30 seconds instead of hanging: the store coalesces onto a request already in flight, so one stuck call would stall every later flush and every caller waiting on a barrier.

### Tested capacity

Measured on the pinned Node 22.23.1 under Linux, seeding accepted offline swaps as the dominant row and checkpointing to a loopback HTTP storage endpoint. "Barrier" is the wait for one further accepted swap to become durable — what a payer actually sits behind. These figures are for **unencrypted** snapshots; authenticated encryption will add to every barrier, so treat them as a floor.

| Accepted swaps | Database | Stored object | Barrier |
| --- | --- | --- | --- |
| 1,000 | 1.3 MB | 0.1 MB | 17 ms |
| 10,000 | 13.3 MB | 0.5 MB | 54 ms |
| 50,000 | 66.0 MB | 2.7 MB | 298 ms |
| 200,000 | 264.3 MB | 10.6 MB | 1.1 s |

About 1.3 KB of database per accepted swap. Snapshots are brotli-compressed before upload — around 25x on this shape of data, because SQLite pages of hex identifiers compress extremely well. Quality 1 was both the fastest to encode and the smallest of the codecs measured, so nothing is traded for it. Transfer was over half of an uncompressed barrier even on loopback; against real storage the reduction matters more than these figures show.

The head's `digest` and `size` describe the **plaintext** image, so a snapshot's identity does not depend on the codec. A stored object is decompressed under a limit taken from that `size`, which stops a small object expanding without bound — but the head is the host's to write, so it can claim any size. That bound is not a defence against the host, and a host intent on denying service can simply not serve.

Compression lowers the constant; it does not change the shape. **A barrier still snapshots the whole database, not the change**, so the wait before a payer receives an invoice remains proportional to total history rather than to current activity. Settlement rows carrying an `address_id` are never reclaimed — they are the owner's history and the only copy of it — so that total only grows. At the volumes above it is comfortable. A deployment expecting sustained traffic needs a retention or archival answer, or checkpoints that ship deltas rather than the whole image, before the barrier becomes the slowest part of a receive.

### Rollback

Nothing in a head reveals a rollback. Every head is internally consistent at every sequence, so a host that retains old snapshots can re-advertise one and the enclave cannot tell from the object alone. Unpinned, that replay is accepted. Two out-of-band pins guard it, and they suit different restarts:

- `ENCLAVE_CHECKPOINT_HEAD` names one exact digest, so it only fits a **controlled** restart: flush on shutdown, record the final digest, boot against it. The digest changes on every flush, so a pin set in advance is stale within seconds and a crash would leave the enclave unable to boot at all.
- `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` names a floor instead, which is what survives a **crash**, where nobody outside the enclave knows which digest the timer wrote last. It blocks any replay below the floor while accepting whatever the enclave legitimately reached above it.

Both are manual stand-ins. The independent checkpoint authority in the approved design — tracking the current head and the active writer — is not built, so an operator advances these by hand and a replay between the floor and the true head is still accepted.

Two enclaves sharing one `ENCLAVE_CHECKPOINT_KEY` would each extend their own chain, and whichever wrote `HEAD.json` last would erase the other's history. Before committing a head, a writer re-reads the stored one and refuses if it is not the head it last wrote — so a second enclave started on a live prefix stops at its first checkpoint, and a writer whose head moved underneath it stops too. Both then read unready. This is detection, not mutual exclusion: the window between that read and the write is still open, and closing it needs the authority's compare-and-set.

## Security Blockers

The pinned runtime allows its SSM overlay to replace `APP_BINARY_NAME` and passes broad environment values to the selected child. A local reproduction against that exact source confirmed the application launcher can be bypassed. Filed upstream as [ArkLabsHQ/enclave#194](https://github.com/ArkLabsHQ/enclave/issues/194). The native LNURL launcher only protects launches that actually reach it. Reproducible PCRs do not cure mutable post-measurement execution. This must be fixed upstream or prevented by independently governed, verified deployment controls before protecting user data.

The runtime also starts automatic successor handoff before the application and does not enforce this application's independent release approval policy; that is covered in the same upstream issue. Do not entrust application storage keys to that managed-secret migration path. An independently governed, attested application-key release path is required unless upstream handoff gains the necessary approval check. Such a key service cannot repair the launcher bypass by itself.

Keep the Enclave dependency unchanged until a reviewed resolution is available. The remaining runtime gate requires a Nitro-capable test instance: real HTTP/SSE, production quote verification, application-key binding, persistence failure injection, protected offline receive/recovery and an approved upgrade. Local smoke tests and browser compilation cannot replace those gates.

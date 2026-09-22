# Enclave Research Build

This packages LNURL for Nitro. It is **not a host-tamper-resistant deployment** yet. Do not enroll real users or put funds or production secrets in this research profile.

The default profile deliberately uses `lnurl.invalid`, an in-memory application database and no managed application secrets. Independent writer fencing, signed owner setup, protected payment proofs, client verification and approved key release are not implemented. SQLite checkpoints are implemented, but their rollback resistance rests on an out-of-band head pin rather than an independent authority — see Durable State. Existing Docker deployments are unchanged.

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

There is no enclave promotion or approval job. Before any protected release, the independent security administrator must approve the measured source/profile after both rebuilds and runtime/security tests. Publish the signed approval manifest separately. An unsigned build manifest, image signature certificate or host-provided PCR value is not a trust root. Existing Docker release jobs are not changed by this research gate.

## Durable State

Nitro gives the workload no persistent disk, so SQLite runs on the enclave's RAM-backed filesystem and durability comes from snapshots held in Enclave's encrypted `/v1/storage` key/value API. `ENCLAVE_CHECKPOINT=1` turns this on. It is off by default, and nothing below changes an ordinary deployment.

| Variable | Meaning |
| --- | --- |
| `ENCLAVE_CHECKPOINT` | `1` enables checkpointing, and defaults `DB_PATH` to `/run/lnurl/state.sqlite`. |
| `ENCLAVE_RUNTIME_TOKEN` | Bearer token the runtime hands the application. Required when enabled. |
| `ENCLAVE_STORAGE_URL` | Runtime storage base URL, default `http://127.0.0.1:7073`. |
| `ENCLAVE_CHECKPOINT_KEY` | Object prefix for this deployment, default `lnurl/db`. Traversal is rejected at config load. |
| `ENCLAVE_CHECKPOINT_INTERVAL_MS` | Background cadence, default `5000`, minimum `100`. |
| `ENCLAVE_CHECKPOINT_ALLOW_GENESIS` | `1` permits a first boot with no prior head. Initial deployment only. |
| `ENCLAVE_CHECKPOINT_HEAD` | The snapshot digest the security administrator says is current. |
| `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` | Lowest head sequence this deployment will restore from. |

Snapshots are taken with `VACUUM INTO`, not `DatabaseSync.serialize`: the pinned Node 22.23.1 has neither `serialize` nor `deserialize` nor `backup` on `node:sqlite`, so anything built on those works only on a newer Node than this image ships. `VACUUM INTO` is byte-stable for unchanged content, so an idle deployment re-advertises its existing head instead of uploading the database again. It stages a full copy in `scratchDir` — the directory holding `DB_PATH` — so budget the database size twice over in enclave memory at checkpoint time.

Boot restores before opening the database: the snapshot is fetched by the exact key the head names, checked against its digest and size, written to `DB_PATH`, and only then opened. Stale `-wal`/`-shm` sidecars are removed first, because a journal belonging to a different image would otherwise be replayed into this one. Restore therefore needs a file-backed `DB_PATH`; `:memory:` is refused. A missing head aborts the boot unless genesis is explicitly allowed, and the state directory is created because the enclave's filesystem starts empty.

An accepted offline swap is committed and then checkpointed before the payer is handed the invoice. A checkpoint that cannot be written fails that request instead of answering with an invoice whose preimage a restart would forget. Background writers do not yet take that barrier.

Everything else the server writes is covered more bluntly. `persistenceCheckpoint` is a required health check, so a failed checkpoint — or silence, meaning no commit within six intervals floored at 30 seconds — reports the server unready and should take it out of rotation rather than let it keep accepting state it cannot persist. Silence is tracked separately from failure because a store that has stopped attempting would otherwise keep answering with its last success. Storage requests time out after 30 seconds instead of hanging: the store coalesces onto a request already in flight, so one stuck call would stall every later flush and every caller waiting on a barrier.

Nothing in a head reveals a rollback. Every head is internally consistent at every sequence, so a host that retains old snapshots can re-advertise one and the enclave cannot tell from the object alone. Unpinned, that replay is accepted. Two out-of-band pins guard it, and they suit different restarts:

- `ENCLAVE_CHECKPOINT_HEAD` names one exact digest, so it only fits a **controlled** restart: flush on shutdown, record the final digest, boot against it. The digest changes on every flush, so a pin set in advance is stale within seconds and a crash would leave the enclave unable to boot at all.
- `ENCLAVE_CHECKPOINT_MIN_SEQUENCE` names a floor instead, which is what survives a **crash**, where nobody outside the enclave knows which digest the timer wrote last. It blocks any replay below the floor while accepting whatever the enclave legitimately reached above it.

Both are manual stand-ins. The independent checkpoint authority in the approved design — tracking the current head and the active writer — is not built, so an operator advances these by hand and a replay between the floor and the true head is still accepted.

## Security Blockers

The pinned runtime allows its SSM overlay to replace `APP_BINARY_NAME` and passes broad environment values to the selected child. A local reproduction against that exact source confirmed the application launcher can be bypassed. Filed upstream as [ArkLabsHQ/enclave#194](https://github.com/ArkLabsHQ/enclave/issues/194). The native LNURL launcher only protects launches that actually reach it. Reproducible PCRs do not cure mutable post-measurement execution. This must be fixed upstream or prevented by independently governed, verified deployment controls before protecting user data.

The runtime also starts automatic successor handoff before the application and does not enforce this application's independent release approval policy; that is covered in the same upstream issue. Do not entrust application storage keys to that managed-secret migration path. An independently governed, attested application-key release path is required unless upstream handoff gains the necessary approval check. Such a key service cannot repair the launcher bypass by itself.

Keep the Enclave dependency unchanged until a reviewed resolution is available. The remaining runtime gate requires a Nitro-capable test instance: real HTTP/SSE, production quote verification, application-key binding, persistence failure injection, protected offline receive/recovery and an approved upgrade. Local smoke tests and browser compilation cannot replace those gates.

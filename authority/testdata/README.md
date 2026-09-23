`nitro-attestation.b64` is a genuine AWS Nitro attestation document, copied unchanged from
[ArkLabsHQ/enclave](https://github.com/ArkLabsHQ/enclave) at `3c33a40ef4a2a49297ab5df5163945fa9e50e544`,
`client/testdata/attestation.b64`. Its certificate chain expired on 2026-04-04, so tests verify it at its
own timestamp.

`wire-vectors.json` is written by `go test ./internal/wire -update` and read by both the Go and the
TypeScript encoders.

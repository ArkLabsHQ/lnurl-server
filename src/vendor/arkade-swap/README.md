# Vendored @arkade-os/swap

Byte-exact copies from `arkade-os/ts-sdk`, commit `2cc527cbb57fa8956df5760fb2b191ae00829746`
(`packages/swap/src/`), vendored because the published `@arkade-os/swap` releases
predate the receive-corridor client this server needs.

Verify fidelity (git blob SHAs must match upstream):

```sh
gh api repos/arkade-os/ts-sdk/git/trees/2cc527cbb57fa8956df5760fb2b191ae00829746?recursive=1 \
  --jq '.tree[] | select(.path | startswith("packages/swap/src/")) | "\(.sha) \(.path)"'
# then locally: git hash-object src/vendor/arkade-swap/<file>
```

Only the lightning-receive slice is exercised: `lightningReceiveRequest`,
`httpTransport` / `nostrRfqTransport` (`nostr.ts`), `deriveLightningReceive`,
`verifyReceiveInvoice`, `assertReceivable`, `assertQuotedAmount`, `sealClaimPacket`.
The rest rides along verbatim so the swap to the published package is a
delete-and-reimport.

**Exit plan:** once `@arkade-os/swap` ships a release carrying the receive corridors
(>= the 0.1.0 rc line), delete this directory and import from the package.

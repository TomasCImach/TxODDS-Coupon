# Devnet release runbook

## Preflight

- Record commit SHA, program binary SHA-256, program ID, PlatformConfig PDA, reward mint, RPC host, database migration versions, container digests, and TxLINE tier.
- Confirm `SOLANA_CLUSTER=devnet`, TxLINE host is `https://txline-dev.txodds.com`, and no Mainnet endpoint or valuable mint appears in server or browser configuration.
- Confirm the classic reward mint has six decimals, no freeze authority, and owner `Tokenkeg…`; the TxLINE TxL mint remains isolated under Token-2022.
- Confirm admin, oracle, relayer, demo, fee payer, sponsor, and TxLINE subscription wallets are distinct where required and have only the secrets their role needs.
- Run `pnpm verify`, native Rust tests, the SBF build, the local-validator Anchor seam, the 1,000-registration/500-claim load harness, both container builds, and browser checks at desktop and 390 px mobile widths.
- Confirm the API refuses new sponsored work below `FEE_PAYER_MIN_LAMPORTS`, accepted duplicates remain readable, and the fee-payer balance gauge/alert is healthy.

## Deployment order

1. Back up PostgreSQL and apply migrations once.
2. Deploy/upgrade the program, verify the binary, and read back PlatformConfig directly from Devnet.
3. Start the chain indexer and wait for projection reconciliation.
4. Start the API, settlement/lifecycle, oracle, TxLINE listener, and demo controller roles.
5. Deploy the web image with immutable `NEXT_PUBLIC_*` Devnet values.
6. Verify `/internal/health`, `/internal/metrics`, `/v1/health/public`, fixture discovery, SSE replay, and browser CSP/network requests.

## Acceptance path

1. Sponsor create → exact fund → activate.
2. Register passkey, external-wallet, and Instant Demo fans without fan SOL.
3. Trigger two overlapping synthetic goals and claim both independent rounds.
4. Verify receipt-only is never shown as a win; verify confirmed rank, Claim PDA, and exact SPL delta.
5. Transfer a reward to an external Devnet address through a fan-signed/platform-fee-paid transaction.
6. Complete the match, close open rounds, make refundable, refund the immutable ATA, close the vault, and release the fixture slot.
7. Repeat using hard timeout rather than provider completion.

## Rollback and shutdown

- A broken web or API image may be rolled back independently; never roll back database migrations destructively.
- Pause campaign writes, registration, round opening, or settlement with the narrow PlatformConfig bit only when its documented incident condition applies. Pause does not authorize seizure or destination changes.
- Stop public TxLINE-derived output immediately if licensing permission changes. Disable raw retention and run the TTL deletion job.
- At hackathon end, revoke/delete TxLINE credentials as required, remove public deployment access, preserve only permitted audit digests and aggregate analytics, and document sponsor refunds.

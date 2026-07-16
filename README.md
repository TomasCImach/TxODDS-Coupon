# GoalDrop

GoalDrop is a Solana Devnet fan-reward race driven by TxLINE football goal events. Sponsors create and exactly prefund immutable goal rounds; fans register and claim without SOL by signing Ed25519 intents; PostgreSQL durably sequences receipts; the Anchor program enforces eligibility, caps, custody, exact classic-SPL payouts, timeout finalization, and immutable refunds.

This repository intentionally implements only the Devnet hackathon MVP described in [PRD.md](./PRD.md) and [architecture.md](./architecture.md). It has no Mainnet deployment configuration, valuable token integration, wagering, swap, NFT, or public TxLINE relay.

## Components

- `programs/goaldrop`: Anchor program and on-chain account/instruction invariants.
- `apps/service`: API plus isolated TxLINE, oracle, settlement/lifecycle, indexer, and demo roles.
- `apps/web`: Next.js sponsor, fan, demo, and partner-embed experiences.
- `packages/protocol`: fixed-width intent and signed-receipt protocol.
- `packages/db`: migrations, challenges, atomic registration, FCFS receipt sequencing, outbox, and projections.
- `packages/txline-adapter`: strict soccer event normalization and idempotency.
- `packages/solana-client`: PDA derivation, account decoding, instruction construction, and sponsored-template policy.
- `packages/ui`: reusable honest-state goal race component.
- `packages/ops`: dry-run-first mint, initialization, reconciliation, pause, authority rotation, and TxLINE activation commands.
- `.github/workflows`: application/load, native Rust, fresh-validator SBF, and release-readiness gates.

## Local verification

Requirements: Node 24+, pnpm 10.33, Docker, Rust 1.89+ (1.97 tested), the Agave/Solana 2.3 SBF toolchain, and Anchor CLI 0.32.1. Keep `Cargo.lock` intact: its compatible transitive versions are intentionally pinned for the SBF toolchain's Rust 1.84 compiler.

```bash
corepack enable
pnpm install
docker compose up -d postgres
DATABASE_URL=postgresql://goaldrop:goaldrop@127.0.0.1:5432/goaldrop pnpm db:migrate
TEST_DATABASE_URL=postgresql://goaldrop:goaldrop@127.0.0.1:5432/goaldrop pnpm test
TEST_DATABASE_URL=postgresql://goaldrop:goaldrop@127.0.0.1:5432/goaldrop pnpm test:load
pnpm typecheck
pnpm build
cargo test -p goaldrop
anchor build
anchor test --skip-build --provider.wallet /absolute/path/to/local-test-wallet.json
```

The load harness first proves 1,000 distinct registration requests can be durably accepted, then models 500 distinct fans over a five-second goal burst. It fails unless all registration rows exist, claim acknowledgement p95 is below 500 ms, all 500 claim receipts exist, and round sequences are contiguous. The Anchor integration suite deploys the compiled SBF binary to a local validator and proves campaign creation with a zero-SOL sponsor, exact funding, gasless registration, goal idempotency, overlapping rounds, strict per-round sequence order, exact payouts, provider and hard-timeout finalization, refund gating, residual refund, vault closure, and fixture-slot release.

Current local evidence and external Devnet release gates are recorded in [docs/implementation-verification.md](./docs/implementation-verification.md).
Requirement-level status is recorded in [docs/prd-traceability.md](./docs/prd-traceability.md); the machine-readable release ledger is [docs/release-blockers.json](./docs/release-blockers.json). `pnpm release:check` intentionally fails until every external blocker is resolved and linked evidence is present.

With private TxLINE credentials present only in the ignored root `.env`, run `pnpm txline:validate-live`. It validates the current authenticated PascalCase fixture/score envelope and goal/correction/finalization semantics while printing only counts and schema-shape digests; it never persists or prints a licensed raw payload.

## Running the application

Copy `.env.example` to `.env` outside version control and fill role-scoped Devnet credentials. Start the API and UI during development with `pnpm dev`; run workers independently with the `start:*` scripts in `apps/service/package.json`. For a container deployment:

```bash
docker compose -f compose.app.yaml up --build
```

The API validates the deployed `PlatformConfig` before any role starts. Authority-bearing roles refuse startup if their key does not match the on-chain configuration. New gasless work is rejected before durable acceptance when the fee payer falls below `FEE_PAYER_MIN_LAMPORTS`; already accepted duplicate requests still return their original signed receipt. The public app communicates with the GoalDrop API, approved passkey/wallet surfaces, and the configured Solana Devnet RPC; TxLINE credentials remain server-side.

## Required Devnet preparation

1. Generate distinct admin, oracle, relayer, demo, fee-payer, sponsor, and TxLINE subscription wallets.
2. Create a classic SPL reward mint with six decimals and no freeze authority.
3. Build/deploy the program, synchronize its declared program ID, and initialize `PlatformConfig` with the reward mint and distinct authorities.
4. Activate the World Cup TxLINE Devnet subscription, retain the guest JWT/API token in the secret store, and run `pnpm txline:validate-live`.
5. Create, exactly fund, and activate a resettable demo campaign; set `DEMO_CAMPAIGN` and `NEXT_PUBLIC_DEMO_CAMPAIGN`.
6. Run the acceptance checklist in [docs/runbooks/devnet-release.md](./docs/runbooks/devnet-release.md).

Never commit keypairs, JWTs, API tokens, `.env` files, captured licensed TxLINE payloads, or Mainnet values. Synthetic fixtures under `tests/fixtures` are invented and safe to commit.

## Truth and privacy boundaries

A receipt proves durable relayer acceptance order, not victory. The UI renders a winner only after a confirmed Claim PDA and matching exact token delta. Live goal correctness trusts the authorized TxLINE listener, and FCFS order trusts the relayer; Solana enforces custody, eligibility, caps, duplicates, sequence processing, and transfer amounts.

Product analytics are first-party, session-scoped, cookieless, disabled by Global Privacy Control, and specified in [analytics.md](./analytics.md). The endpoint rejects wallet addresses, signatures, nonces, passkey metadata, destinations, and token-account identifiers.

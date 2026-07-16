# Exact remaining unblock checklist

As of July 16, 2026, GoalDrop's program, Devnet campaign, authenticated TxLINE adapter, public-RPC decision, timeout policy, valueless demo-token faucet, and memory-only Instant Demo containment are complete. `pnpm release:check` now reports only RB-1, RB-3, and RB-4.

## 1. Obtain written TxODDS permission (RB-1)

Send this request to the TxODDS hackathon sponsor contact and retain the written response:

> GoalDrop requests permission for its public Solana Devnet hackathon demo to display only derived fixture identity, scheduled time, provider phase/status, and GoalDrop round state. TxLINE credentials and raw payloads stay server-side; public replay/pass-through is disabled; raw retention is disabled; synthetic events are conspicuously labeled; only normalized decisions/digests and aggregate evidence are retained through judging. Please confirm that this derived display/caching behavior and synthetic demo are permitted, and state any required shutdown/deletion date.

Save a secret-redacted copy or summary under `docs/evidence/` and change RB-1 to `resolved` with that path. Do not commit private correspondence, credentials, or licensed payloads.

## 2. Obtain the production Passkeys App ID and run the device matrix (RB-3)

1. Submit the [Passkeys Foundation access form](https://passkeys.foundation/) for a production App ID. Their current documentation says an App ID is required for production.
2. Put the issued UUID in the deployment secret/config as `NEXT_PUBLIC_PASSKEY_APP_ID`; it is an identifier, not a private key.
3. Rebuild the exact web image.
4. On at least one Apple/Safari path and one Chrome/Android or Chrome/macOS path, record pass/fail for:
   - Wallet Standard discovery and connection;
   - registration-message signing;
   - Solana transaction signing through the sponsor or transfer flow;
   - same-address recovery on a synced/second device;
   - provider key export availability, without recording or sharing the exported key;
   - disconnect/reconnect and the judge Quickstart.
5. Record browser/OS/SDK versions, public wallet address, public Devnet signatures, and outcomes only. Never capture biometrics, passkey credentials, seed/private keys, or session tokens.

## 3. Fund and run the 100-winner Devnet benchmark (RB-4)

Current fee-payer/operator address:

```text
AZg8a2ii3AiVuVFXJQU4M9T4KuUGoCQ8vLdiZyEWA7Xi
```

The validated balance after the faucet acceptance is `0.744458170 SOL`. Current Devnet rent is 1,781,760 lamports per Registration, 2,282,880 per Claim, and 2,039,280 per new ATA: 6,103,920 lamports per new winner. One hundred new winners plus conservative fees require about 0.611892 SOL. Preserving the 0.5 SOL circuit breaker therefore requires at least `0.367433830 SOL` more; add `1 Devnet SOL` to leave retry headroom.

Two public RPC airdrop requests (1 SOL and 0.5 SOL) were attempted and rate-limited. Use one of the programmatic options in the [official Solana Devnet faucet guide](https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets), then ask Codex to continue. Codex should create a separate benchmark campaign—never consume the untouched judge campaign—and record transaction bytes, CU, first/last confirmation time, retries, exact 100/100 payout count, contiguous rank/sequence, and vault accounting.

## 4. Choose the public application runtime

The program is public on Devnet, but the verified web/service containers still need a public HTTPS runtime and PostgreSQL instance. Provide the target (for example, an existing container host plus registry/database credentials) or authorize setup on a named provider. Deployment must use secret storage, run migrations once, publish the API/web/worker roles, and record immutable image digests and the public URL before submission.

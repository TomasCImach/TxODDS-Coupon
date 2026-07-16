# Exact remaining unblock checklist

As of July 16, 2026, GoalDrop's program, Devnet campaign, authenticated TxLINE adapter and permission disposition, public-RPC decision and 100/100 claim benchmark, timeout policy, valueless demo-token faucet, and memory-only Instant Demo containment are complete. `pnpm release:check` reports only RB-3.

## 1. Complete the production Passkeys device matrix (RB-3)

1. Devnet builds intentionally do not require `NEXT_PUBLIC_PASSKEY_APP_ID`. For a production-tier deployment, submit the [Passkeys Foundation access form](https://passkeys.foundation/), put the issued UUID in deployment config, and set `NEXT_PUBLIC_DEPLOYMENT_TIER=production`; the build fails closed when the App ID is missing.
2. Rebuild the exact web image.
3. On at least one Apple/Safari path and one Chrome/Android or Chrome/macOS path, record pass/fail for:
   - Wallet Standard discovery and connection;
   - registration-message signing;
   - Solana transaction signing through the sponsor or transfer flow;
   - same-address recovery on a synced/second device;
   - provider key export availability, without recording or sharing the exported key;
   - disconnect/reconnect and the judge Quickstart.
4. Record browser/OS/SDK versions, public wallet address, public Devnet signatures, and outcomes only. Never capture biometrics, passkey credentials, seed/private keys, or session tokens.

## 2. Choose the public application runtime

The program is public on Devnet, but the verified web/service containers still need a public HTTPS runtime and PostgreSQL instance. Provide the target (for example, an existing container host plus registry/database credentials) or authorize setup on a named provider. Deployment must use secret storage, run migrations once, publish the API/web/settlement/lifecycle/oracle/TxLINE/demo roles within the confirmed permission, and record immutable image digests and the public URL before submission.

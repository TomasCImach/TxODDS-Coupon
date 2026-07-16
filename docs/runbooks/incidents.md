# Incident responses

| Signal                       | Immediate action                                                                                                           | Recovery proof                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| TxLINE `401`                 | Renew guest JWT once and retry with the existing API token.                                                                | Snapshot and SSE succeed without logging either credential.            |
| TxLINE `403`                 | Stop live opening, emit degraded state, verify Devnet subscription/token/network.                                          | Private fixture snapshot plus entitlement check.                       |
| Listener gap                 | Reconcile recent five-minute intervals, then resume with `Last-Event-ID`. Do not open goals older than the lateness bound. | Event-key and cursor audit.                                            |
| Oracle ambiguous response    | Query GoalReceipt/Round PDAs before resubmission.                                                                          | Exactly one receipt/round for the event key.                           |
| Sequence store unavailable   | Reject new claim acceptance; do not issue a receipt.                                                                       | Database primary healthy and counters contiguous.                      |
| Relayer or fee payer low SOL | Stop new acceptance before spend exhaustion and report unavailable.                                                        | Balance restored; no receipt falsely represented as submitted.         |
| Vault deficit                | Stop settlement, emit degraded state, compare account history and campaign accounting.                                     | Actual balance is at least funded + external inflow − paid − refunded. |
| RPC ambiguity                | Reconcile transaction signature and target PDA before retry.                                                               | Confirmed/finalized account and exact token delta.                     |
| Passkey provider outage      | Offer Wallet Standard and Instant Demo paths; do not promise unavailable recovery.                                         | Tested sign-message flow restored.                                     |
| Suspected key compromise     | Pause the affected operation and rotate only that authority with admin.                                                    | Authority epoch and service configuration match on-chain.              |

## Administrative changes

Pause and rotation commands are dry-run by default, refuse Mainnet endpoints, require an audit reason, simulate the exact signed transaction, and verify on-chain readback after submission. Record their JSON output in the incident evidence store.

```bash
AUDIT_REASON="claim admission paused during incident INC-123" \
PAUSE_MASK=8 \
ADMIN_KEYPAIR=/secure/admin.json \
GOALDROP_PROGRAM_ID=<devnet-program> \
pnpm --filter @goaldrop/ops program:pause

# Repeat only after reviewing the dry-run output.
DRY_RUN=false AUDIT_REASON="claim admission paused during incident INC-123" \
PAUSE_MASK=8 ADMIN_KEYPAIR=/secure/admin.json \
GOALDROP_PROGRAM_ID=<devnet-program> \
pnpm --filter @goaldrop/ops program:pause
```

Use `program:rotate` with `AUTHORITY_ROLE=admin|oracle|relayer|demo` and `NEW_AUTHORITY=<pubkey>`. Set `EXPECTED_AUTHORITY_EPOCH` on live changes to stop if another administrator changed configuration after review. Pause bits affect only campaign writes, registration, round opening, and settlement; close, timeout finalization, make-refundable, refund, and fixture release remain permissionless.

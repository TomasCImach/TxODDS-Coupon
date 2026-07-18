import { randomUUID } from "node:crypto";
import type { DatabasePool } from "@goaldrop/db";
import {
  CampaignState,
  RoundSource,
  RoundState,
  TerminalReason,
} from "@goaldrop/protocol";
import {
  anchorDiscriminator,
  decodeCampaignAccount,
  decodeClaimAccount,
  decodeRegistrationAccount,
  decodeRoundAccount,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Logs,
} from "@solana/web3.js";
import type { ServiceConfig } from "../config.js";
import { connectionFor } from "./solana.js";

interface WorkerLogger {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

const eventNames = [
  "CampaignCreated",
  "CampaignFunded",
  "CampaignActivated",
  "FanRegistered",
  "RoundOpened",
  "ClaimPaid",
  "SequenceSkipped",
  "RoundClosed",
  "MatchCompleted",
  "CampaignRefundable",
  "CampaignRefunded",
  "AuthorityRotated",
  "PauseChanged",
] as const;
const eventDiscriminators = new Map(
  eventNames.map((name) => [
    anchorDiscriminator("event", name).toString("hex"),
    name,
  ]),
);

export async function runChainIndexer(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: WorkerLogger,
  signal: AbortSignal,
): Promise<void> {
  const connection = connectionFor(config);
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const subscription = connection.onLogs(
    programId,
    (logs, context) => {
      void persistLogs(pool, logs, context.slot).catch((error: unknown) =>
        logger.error(
          { reason: safeMessage(error) },
          "program log persistence failed",
        ),
      );
    },
    "confirmed",
  );
  try {
    if (config.DEMO_CAMPAIGN) {
      try {
        await reconcileAccounts(config, connection, pool, programId, false);
      } catch (error) {
        logger.warn(
          { reason: safeMessage(error), campaign: config.DEMO_CAMPAIGN },
          "targeted demo-campaign reconciliation failed; continuing with normal indexer recovery",
        );
      }
    }
    try {
      await catchUpLogs(connection, pool, programId);
    } catch (error) {
      logger.warn(
        { reason: safeMessage(error) },
        "historical program log catch-up unavailable; continuing with live logs and account reconciliation",
      );
    }
    let broadAccountScanEnabled = true;
    while (!signal.aborted) {
      try {
        const nextBroadAccountScanEnabled = await reconcileAccounts(
          config,
          connection,
          pool,
          programId,
          broadAccountScanEnabled,
        );
        if (broadAccountScanEnabled && !nextBroadAccountScanEnabled) {
          logger.warn(
            { campaign: config.DEMO_CAMPAIGN ?? null },
            "broad program-account scan unavailable; using targeted demo-campaign reconciliation",
          );
        }
        broadAccountScanEnabled = nextBroadAccountScanEnabled;
        await advanceFinality(connection, pool);
      } catch (error) {
        logger.error(
          { reason: safeMessage(error) },
          "chain reconciliation cycle failed",
        );
      }
      await delay(5_000, signal);
    }
  } finally {
    await connection
      .removeOnLogsListener(await subscription)
      .catch(() => undefined);
  }
}

async function catchUpLogs(
  connection: Connection,
  pool: DatabasePool,
  programId: PublicKey,
): Promise<void> {
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { limit: 200 },
    "confirmed",
  );
  for (const item of signatures.reverse()) {
    const transaction = await connection.getTransaction(item.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction?.meta?.logMessages) {
      await persistLogs(
        pool,
        {
          signature: item.signature,
          err: item.err,
          logs: transaction.meta.logMessages,
        },
        transaction.slot,
      );
    }
  }
}

async function persistLogs(
  pool: DatabasePool,
  logs: Logs,
  slot: number,
): Promise<void> {
  if (logs.err) return;
  let eventIndex = 0;
  for (const line of logs.logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    if (data.length < 8) continue;
    const name = eventDiscriminators.get(data.subarray(0, 8).toString("hex"));
    if (!name) continue;
    const eventData = decodeEvent(name, data.subarray(8));
    await pool.query(
      `INSERT INTO program_events (
         signature, instruction_index, event_index, slot, commitment, event_name, event_data
       ) VALUES ($1,0,$2,$3,'confirmed',$4,$5::jsonb)
       ON CONFLICT (signature, instruction_index, event_index) DO UPDATE SET
         slot = EXCLUDED.slot, commitment = EXCLUDED.commitment, event_name = EXCLUDED.event_name, event_data = EXCLUDED.event_data`,
      [logs.signature, eventIndex, slot, name, JSON.stringify(eventData)],
    );
    eventIndex += 1;
  }
}

async function reconcileAccounts(
  config: ServiceConfig,
  connection: Connection,
  pool: DatabasePool,
  programId: PublicKey,
  broadAccountScanEnabled: boolean,
): Promise<boolean> {
  const slot = await connection.getSlot("confirmed");
  type ProgramAccount = { pubkey: PublicKey; account: AccountInfo<Buffer> };
  let campaigns: readonly ProgramAccount[] = [];
  let rounds: readonly ProgramAccount[] = [];
  let registrations: readonly ProgramAccount[] = [];
  let claims: readonly ProgramAccount[] = [];
  if (broadAccountScanEnabled) {
    try {
      [campaigns, rounds, registrations, claims] = await Promise.all([
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: 424 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: 216 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: 128 }],
        }),
        connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [{ dataSize: 200 }],
        }),
      ]);
    } catch {
      broadAccountScanEnabled = false;
    }
  }
  if (!broadAccountScanEnabled) {
    const managed = await pool.query<{ campaign: string }>(
      `SELECT campaign FROM demo_campaigns
       UNION SELECT $1 WHERE $1::text IS NOT NULL`,
      [config.DEMO_CAMPAIGN ?? null],
    );
    const addresses = managed.rows.map((row) => new PublicKey(row.campaign));
    if (addresses.length > 0) {
      const accounts = await connection.getMultipleAccountsInfo(
        addresses,
        "confirmed",
      );
      campaigns = addresses.flatMap((pubkey, index) => {
        const account = accounts[index];
        return account?.owner.equals(programId) && account.data.length === 424
          ? [{ pubkey, account }]
          : [];
      });
    }
  }
  for (const item of campaigns) {
    const campaign = decodeCampaignAccount(item.account.data);
    const states = [
      "draft",
      "funded",
      "active",
      "cancelled",
      "refundable",
      "refunded",
    ] as const;
    const terminals = [
      "none",
      "provider_finalised",
      "provider_cancelled",
      "provider_abandoned",
      "hard_timeout",
    ] as const;
    await pool.query(
      `INSERT INTO campaign_projections (
         campaign, fixture_id, sponsor, state, reward_mint, refund_wallet, scheduled_start,
         registration_deadline, expected_end, hard_expiry, terminal_reason, required_funding,
         funded_amount, paid_amount, refunded_amount, external_inflow_total, last_slot, commitment
       ) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),to_timestamp($9),to_timestamp($10),
                 $11,$12,$13,$14,$15,$16,$17,'confirmed')
       ON CONFLICT (campaign) DO UPDATE SET state = EXCLUDED.state, terminal_reason = EXCLUDED.terminal_reason,
         funded_amount = EXCLUDED.funded_amount, paid_amount = EXCLUDED.paid_amount,
         refunded_amount = EXCLUDED.refunded_amount, external_inflow_total = EXCLUDED.external_inflow_total,
         last_slot = EXCLUDED.last_slot, commitment = EXCLUDED.commitment, updated_at = clock_timestamp()`,
      [
        item.pubkey.toBase58(),
        campaign.fixtureId.toString(),
        campaign.sponsor.toBase58(),
        states[campaign.state] ?? "draft",
        campaign.rewardMint.toBase58(),
        campaign.refundWallet.toBase58(),
        campaign.scheduledStart.toString(),
        campaign.registrationDeadline.toString(),
        campaign.expectedEnd.toString(),
        campaign.hardExpiry.toString(),
        terminals[campaign.terminalReason] ?? "none",
        campaign.requiredFunding.toString(),
        campaign.fundedAmount.toString(),
        campaign.paidAmount.toString(),
        campaign.refundedAmount.toString(),
        campaign.externalInflowTotal.toString(),
        slot,
      ],
    );
    for (let ordinal = 0; ordinal < campaign.rounds.length; ordinal += 1) {
      const configuredRound = campaign.rounds[ordinal];
      if (!configuredRound) continue;
      await pool.query(
        `INSERT INTO campaign_round_configs (campaign, ordinal, reward_amount, winner_cap)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (campaign, ordinal) DO UPDATE SET reward_amount = EXCLUDED.reward_amount,
           winner_cap = EXCLUDED.winner_cap, updated_at = clock_timestamp()`,
        [
          item.pubkey.toBase58(),
          ordinal,
          configuredRound.rewardAmount.toString(),
          configuredRound.winnerCap,
        ],
      );
    }
    if (campaign.state !== CampaignState.Refunded) {
      await reconcileVault(
        config,
        connection,
        pool,
        programId,
        item.pubkey,
        campaign,
      );
    }
  }
  for (const item of rounds) {
    const round = decodeRoundAccount(item.account.data);
    const states = ["open", "exhausted", "expired"] as const;
    const sources = ["live", "demo"] as const;
    await pool.query(
      `INSERT INTO round_projections (
         round, campaign, ordinal, source, event_key, opened_at, closes_at, reward_amount,
         winner_cap, winner_count, next_chain_sequence, skipped_count, paid_total, state, last_slot, commitment
       ) VALUES ($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),$8,$9,$10,$11,$12,$13,$14,$15,'confirmed')
       ON CONFLICT (round) DO UPDATE SET winner_count = EXCLUDED.winner_count,
         next_chain_sequence = EXCLUDED.next_chain_sequence, skipped_count = EXCLUDED.skipped_count,
         paid_total = EXCLUDED.paid_total, state = EXCLUDED.state, last_slot = EXCLUDED.last_slot,
         commitment = EXCLUDED.commitment, updated_at = clock_timestamp()`,
      [
        item.pubkey.toBase58(),
        round.campaign.toBase58(),
        round.ordinal,
        sources[round.source] ?? "live",
        Buffer.from(round.eventHash),
        round.openedAt.toString(),
        round.closesAt.toString(),
        round.rewardAmount.toString(),
        round.winnerCap,
        round.winnerCount,
        round.nextSequence.toString(),
        round.skippedCount,
        round.paidTotal.toString(),
        states[round.state] ?? "expired",
        slot,
      ],
    );
  }
  for (const item of registrations) {
    const registration = decodeRegistrationAccount(item.account.data);
    await pool.query(
      `INSERT INTO registration_projections (
         campaign, wallet, registration_pda, confirmed_slot, transaction_signature, commitment, registered_at
       ) VALUES ($1,$2,$3,$4,'reconciled','confirmed',to_timestamp($5))
       ON CONFLICT (campaign, wallet) DO UPDATE SET confirmed_slot = EXCLUDED.confirmed_slot,
         commitment = EXCLUDED.commitment`,
      [
        registration.campaign.toBase58(),
        registration.wallet.toBase58(),
        item.pubkey.toBase58(),
        slot,
        registration.registeredAt.toString(),
      ],
    );
  }
  for (const item of claims) {
    const claim = decodeClaimAccount(item.account.data);
    await pool.query(
      `UPDATE claim_requests SET status = CASE WHEN status = 'finalized' THEN status ELSE 'confirmed' END,
         claim_pda = $3, winner_rank = $4, updated_at = clock_timestamp()
       WHERE round = $1 AND wallet = $2`,
      [
        claim.round.toBase58(),
        claim.wallet.toBase58(),
        item.pubkey.toBase58(),
        claim.winnerRank,
      ],
    );
  }
  return broadAccountScanEnabled;
}

async function reconcileVault(
  config: ServiceConfig,
  connection: Connection,
  pool: DatabasePool,
  programId: PublicKey,
  campaignAddress: PublicKey,
  campaign: ReturnType<typeof decodeCampaignAccount>,
): Promise<void> {
  const [vault] = vaultPda(programId, campaignAddress);
  const balance = await connection
    .getTokenAccountBalance(vault, "confirmed")
    .catch(() => null);
  if (!balance) return;
  const actual = BigInt(balance.value.amount);
  const expected =
    campaign.fundedAmount +
    campaign.externalInflowTotal -
    campaign.paidAmount -
    campaign.refundedAmount;
  if (actual < expected) {
    const traceId = randomUUID();
    await pool.query(
      `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
       VALUES ($1,'service.degraded',$2::jsonb,$3)`,
      [
        campaignAddress.toBase58(),
        JSON.stringify({ service: "vault_accounting", reason: "deficit" }),
        traceId,
      ],
    );
    await pool.query(
      `INSERT INTO audit_log (actor_type, action, target_type, target_key, reason, trace_id)
       VALUES ('indexer','vault_deficit','campaign',$1,$2,$3)`,
      [
        campaignAddress.toBase58(),
        `expected ${expected}, observed ${actual}`,
        traceId,
      ],
    );
  }
}

async function advanceFinality(
  connection: Connection,
  pool: DatabasePool,
): Promise<void> {
  const rows = await pool.query<{ signature: string }>(
    "SELECT DISTINCT signature FROM program_events WHERE commitment = 'confirmed' ORDER BY signature LIMIT 256",
  );
  if (rows.rows.length === 0) return;
  const signatures = rows.rows.map((row) => row.signature);
  const statuses = await connection.getSignatureStatuses(signatures, {
    searchTransactionHistory: true,
  });
  for (let index = 0; index < signatures.length; index += 1) {
    if (statuses.value[index]?.confirmationStatus === "finalized") {
      await pool.query(
        "UPDATE program_events SET commitment = 'finalized' WHERE signature = $1",
        [signatures[index]],
      );
      await pool.query(
        "UPDATE chain_transactions SET status = 'finalized', finalized_at = clock_timestamp(), updated_at = clock_timestamp() WHERE signature = $1",
        [signatures[index]],
      );
    }
  }
}

function decodeEvent(name: string, data: Buffer): Record<string, unknown> {
  try {
    let offset = 0;
    const byte = () => data[offset++] ?? 0;
    const key = () => {
      const value = new PublicKey(
        data.subarray(offset, offset + 32),
      ).toBase58();
      offset += 32;
      return value;
    };
    const uint16 = () => {
      const value = data.readUInt16LE(offset);
      offset += 2;
      return value;
    };
    const uint32 = () => {
      const value = data.readUInt32LE(offset);
      offset += 4;
      return value;
    };
    const uint64 = () => {
      const value = data.readBigUInt64LE(offset).toString();
      offset += 8;
      return value;
    };
    const int64 = () => {
      const value = data.readBigInt64LE(offset).toString();
      offset += 8;
      return value;
    };
    const bytes32 = () => {
      const value = data.subarray(offset, offset + 32).toString("hex");
      offset += 32;
      return value;
    };
    if (name === "CampaignCreated")
      return {
        version: byte(),
        campaign: key(),
        fixtureId: uint64(),
        sponsor: key(),
        mint: key(),
        requiredFunding: uint64(),
        roundCount: byte(),
      };
    if (name === "CampaignFunded")
      return { campaign: key(), amount: uint64(), vault: key() };
    if (name === "CampaignActivated")
      return {
        campaign: key(),
        activatedAt: int64(),
        registrationDeadline: int64(),
        hardExpiry: int64(),
      };
    if (name === "FanRegistered")
      return {
        campaign: key(),
        wallet: key(),
        registeredAt: int64(),
        intentHash: bytes32(),
      };
    if (name === "RoundOpened")
      return {
        campaign: key(),
        round: key(),
        ordinal: byte(),
        source: byte(),
        eventHash: bytes32(),
        openedAt: int64(),
        closesAt: int64(),
        rewardAmount: uint64(),
        winnerCap: uint16(),
      };
    if (name === "ClaimPaid")
      return {
        campaign: key(),
        round: key(),
        wallet: key(),
        sequence: uint64(),
        winnerRank: uint16(),
        amount: uint64(),
        intentHash: bytes32(),
      };
    if (name === "SequenceSkipped")
      return {
        campaign: key(),
        round: key(),
        sequence: uint64(),
        intentHash: bytes32(),
        reason: byte(),
      };
    if (name === "RoundClosed")
      return {
        campaign: key(),
        round: key(),
        state: byte(),
        winners: uint16(),
        paidTotal: uint64(),
        skippedCount: uint32(),
      };
    if (name === "MatchCompleted")
      return {
        campaign: key(),
        terminalReason: byte(),
        providerActionId: uint64(),
        providerSeq: uint32(),
        completedAt: int64(),
      };
    return { encoded: data.toString("base64") };
  } catch {
    return { malformed: true, encoded: data.toString("base64") };
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

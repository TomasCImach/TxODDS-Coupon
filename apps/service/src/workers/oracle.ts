import { randomUUID } from "node:crypto";
import { bytesFromHex, RoundSource, TerminalReason } from "@goaldrop/protocol";
import {
  claimOutboxBatch,
  deferOutbox,
  markOutboxPublished,
  type DatabasePool,
  type OutboxMessage,
} from "@goaldrop/db";
import {
  configPda,
  decodeCampaignAccount,
  decodeRoundAccount,
  goalReceiptPda,
  markMatchCompleteInstruction,
  openLiveRoundInstruction,
  roundPda,
} from "@goaldrop/solana-client";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { ServiceConfig } from "../config.js";
import {
  connectionFor,
  keypairFromConfig,
  resolveGoalRound,
  sendWorkerTransaction,
  waitForAccount,
} from "./solana.js";

interface WorkerLogger {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

const goalPayload = z.object({
  campaign: z.string(),
  fixtureId: z.string().regex(/^\d+$/),
  eventKey: z.string().regex(/^[0-9a-f]{64}$/),
  actionId: z.string().regex(/^\d+$/),
  seq: z.number().int().nonnegative(),
  status: z.number().int(),
  confirmed: z.boolean(),
  rawDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerTimestampMs: z.string().regex(/^\d+$/),
});
const completionPayload = z.object({
  campaign: z.string(),
  fixtureId: z.string(),
  seq: z.string().regex(/^\d+$/),
});

export async function runOracleWorker(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: WorkerLogger,
  signal: AbortSignal,
): Promise<void> {
  const connection = connectionFor(config);
  const oracle = keypairFromConfig(config.ORACLE_KEYPAIR, "ORACLE_KEYPAIR");
  const feePayer = keypairFromConfig(
    config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  while (!signal.aborted) {
    const messages = await claimOutboxBatch(
      pool,
      ["goal.qualifying", "match.complete"],
      20,
    );
    if (messages.length === 0) {
      await delay(300, signal);
      continue;
    }
    for (const message of messages) {
      try {
        if (message.eventType === "goal.qualifying") {
          await processGoal(
            config,
            pool,
            connection,
            oracle,
            feePayer,
            message,
          );
        } else {
          await processCompletion(
            config,
            pool,
            connection,
            oracle,
            feePayer,
            message,
          );
        }
        await markOutboxPublished(pool, message.id);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "unknown oracle error";
        logger.error(
          {
            outboxId: message.id.toString(),
            eventType: message.eventType,
            reason,
          },
          "oracle command failed",
        );
        await deferOutbox(pool, message.id, reason);
      }
    }
  }
}

async function processGoal(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  oracle: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  message: OutboxMessage,
): Promise<void> {
  const payload = goalPayload.parse(message.payload);
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const campaignAddress = new PublicKey(payload.campaign);
  const [configAddress] = configPda(programId);
  const campaignInfo = await connection.getAccountInfo(
    campaignAddress,
    "confirmed",
  );
  if (!campaignInfo || !campaignInfo.owner.equals(programId))
    throw new Error("campaign account is absent or has wrong owner");
  const campaign = decodeCampaignAccount(campaignInfo.data);
  if (campaign.fixtureId !== BigInt(payload.fixtureId))
    throw new Error("provider fixture disagrees with campaign");
  const eventHash = bytesFromHex(payload.eventKey, 32);
  const [goalReceipt] = goalReceiptPda(programId, campaignAddress, eventHash);
  const receiptInfo = await connection.getAccountInfo(goalReceipt, "confirmed");
  const resolved = resolveGoalRound({
    programId,
    campaignAddress,
    campaign,
    eventHash,
    expectedSource: RoundSource.Live,
    receiptInfo,
  });
  if (!resolved) {
    await pool.query(
      "UPDATE goal_decisions SET oracle_status = 'not_required', reason = 'goal_no_reward' WHERE event_key = $1",
      [Buffer.from(payload.eventKey, "hex")],
    );
    return;
  }
  const [roundAddress] = roundPda(programId, campaignAddress, resolved.ordinal);
  let signature: string | undefined;
  if (!resolved.alreadyOpened) {
    const ix = openLiveRoundInstruction(
      programId,
      {
        config: configAddress,
        oracle: oracle.publicKey,
        feePayer: feePayer.publicKey,
        campaign: campaignAddress,
        round: roundAddress,
        goalReceipt,
      },
      {
        fixtureId: campaign.fixtureId,
        eventHash,
        providerActionId: BigInt(payload.actionId),
        providerSeq: payload.seq,
        providerStatus: payload.status,
        confirmedAtOpen: payload.confirmed,
        providerTsMs: BigInt(payload.providerTimestampMs),
        rawDigest: bytesFromHex(payload.rawDigest, 32),
      },
    );
    try {
      signature = (
        await sendWorkerTransaction({
          config,
          pool,
          connection,
          purpose: "open_live_round",
          aggregateKey: payload.eventKey,
          instructions: [ix],
          feePayer,
          authority: oracle,
          compute: { units: 180_000, microLamports: 1_000 },
          traceId: message.traceId,
        })
      ).signature;
    } catch (error) {
      if (!(await waitForAccount(connection, goalReceipt, 2))) throw error;
      signature = (
        await connection.getSignaturesForAddress(
          goalReceipt,
          { limit: 1 },
          "confirmed",
        )
      )[0]?.signature;
    }
  } else {
    signature = (
      await connection.getSignaturesForAddress(
        goalReceipt,
        { limit: 1 },
        "confirmed",
      )
    )[0]?.signature;
  }
  const roundData = await waitForAccount(connection, roundAddress);
  if (!roundData)
    throw new Error("round was not visible at confirmed commitment");
  const round = decodeRoundAccount(roundData);
  const slot = await connection.getSlot("confirmed");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO round_projections (
         round, campaign, ordinal, source, event_key, opened_at, closes_at, reward_amount,
         winner_cap, winner_count, next_chain_sequence, skipped_count, paid_total, state, last_slot, commitment
       ) VALUES ($1,$2,$3,'live',$4,to_timestamp($5),to_timestamp($6),$7,$8,$9,$10,$11,$12,'open',$13,'confirmed')
       ON CONFLICT (round) DO UPDATE SET state = EXCLUDED.state, last_slot = EXCLUDED.last_slot,
         commitment = EXCLUDED.commitment, updated_at = clock_timestamp()`,
      [
        roundAddress.toBase58(),
        campaignAddress.toBase58(),
        round.ordinal,
        Buffer.from(round.eventHash),
        round.openedAt.toString(),
        round.closesAt.toString(),
        round.rewardAmount.toString(),
        round.winnerCap,
        round.winnerCount,
        round.nextSequence.toString(),
        round.skippedCount,
        round.paidTotal.toString(),
        slot,
      ],
    );
    await client.query(
      "UPDATE goal_decisions SET oracle_status = 'confirmed', oracle_signature = $2 WHERE event_key = $1",
      [Buffer.from(payload.eventKey, "hex"), signature ?? null],
    );
    if (config.TXLINE_PUBLIC_OUTPUT_ENABLED) {
      await client.query(
        `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
         VALUES ($1,'round.opened',$2::jsonb,$3)`,
        [
          campaignAddress.toBase58(),
          JSON.stringify({
            round: roundAddress.toBase58(),
            ordinal: round.ordinal,
            source: "live",
            openedAt: Number(round.openedAt),
            closesAt: Number(round.closesAt),
            rewardAmount: round.rewardAmount.toString(),
            winnerCap: round.winnerCap,
            transactionSignature: signature ?? null,
          }),
          message.traceId,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function processCompletion(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  oracle: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  message: OutboxMessage,
): Promise<void> {
  const payload = completionPayload.parse(message.payload);
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const campaign = new PublicKey(payload.campaign);
  const [configAddress] = configPda(programId);
  let state = await readCampaign(connection, programId, campaign);
  let signature: string | undefined;
  if (state.terminalReason === TerminalReason.None) {
    const ix = markMatchCompleteInstruction(
      programId,
      { config: configAddress, campaign, oracle: oracle.publicKey },
      {
        terminalReason: TerminalReason.ProviderFinalised,
        providerActionId: 0n,
        providerSeq: Number(payload.seq),
      },
    );
    try {
      signature = (
        await sendWorkerTransaction({
          config,
          pool,
          connection,
          purpose: "mark_match_complete",
          aggregateKey: payload.campaign,
          instructions: [ix],
          feePayer,
          authority: oracle,
          compute: { units: 80_000, microLamports: 1_000 },
          traceId: message.traceId,
        })
      ).signature;
    } catch (error) {
      const reconciled = await waitForTerminalCampaign(
        connection,
        programId,
        campaign,
      );
      if (!reconciled) throw error;
      state = reconciled;
    }
    if (state.terminalReason === TerminalReason.None)
      state = await readCampaign(connection, programId, campaign);
  }
  if (!signature) {
    const recorded = await pool.query<{ signature: string | null }>(
      `SELECT signature FROM chain_transactions
       WHERE purpose = 'mark_match_complete' AND aggregate_key = $1 AND trace_id = $2
       ORDER BY id DESC LIMIT 1`,
      [payload.campaign, message.traceId],
    );
    signature = recorded.rows[0]?.signature ?? undefined;
  }
  const terminalReason = terminalReasonName(state.terminalReason);
  if (terminalReason === "none")
    throw new Error("campaign did not reach a terminal on-chain state");
  await pool.query(
    `UPDATE campaign_projections SET terminal_reason = $2, updated_at = clock_timestamp()
     WHERE campaign = $1`,
    [payload.campaign, terminalReason],
  );
  await pool.query(
    `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
     VALUES ($1,'campaign.updated',$2::jsonb,$3)`,
    [
      payload.campaign,
      JSON.stringify({
        campaign: payload.campaign,
        terminalReason,
        transactionSignature: signature ?? null,
      }),
      message.traceId,
    ],
  );
}

async function readCampaign(
  connection: ReturnType<typeof connectionFor>,
  programId: PublicKey,
  campaign: PublicKey,
) {
  const info = await connection.getAccountInfo(campaign, "confirmed");
  if (!info || !info.owner.equals(programId) || info.data.length !== 424)
    throw new Error("campaign account is absent or has wrong owner/layout");
  return decodeCampaignAccount(info.data);
}

async function waitForTerminalCampaign(
  connection: ReturnType<typeof connectionFor>,
  programId: PublicKey,
  campaign: PublicKey,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await readCampaign(connection, programId, campaign);
    if (state.terminalReason !== TerminalReason.None) return state;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

function terminalReasonName(value: number): string {
  const names = [
    "none",
    "provider_finalised",
    "provider_cancelled",
    "provider_abandoned",
    "hard_timeout",
  ] as const;
  const name = names[value];
  if (!name) throw new Error(`unknown campaign terminal reason ${value}`);
  return name;
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

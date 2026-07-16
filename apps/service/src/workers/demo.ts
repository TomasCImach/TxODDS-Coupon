import { sha256 } from "@noble/hashes/sha2.js";
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
  openDemoRoundInstruction,
  roundPda,
} from "@goaldrop/solana-client";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { ServiceConfig } from "../config.js";
import {
  connectionFor,
  keypairFromConfig,
  sendWorkerTransaction,
  waitForAccount,
} from "./solana.js";

interface WorkerLogger {
  error(object: unknown, message?: string): void;
}
const goalPayload = z.object({
  campaign: z.string(),
  step: z.number().int().min(1).max(32),
  label: z.literal("SIMULATED DEVNET EVENT"),
});
const completePayload = z.object({
  campaign: z.string(),
  label: z.literal("SIMULATED DEVNET EVENT"),
});

export async function runDemoController(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: WorkerLogger,
  signal: AbortSignal,
): Promise<void> {
  const connection = connectionFor(config);
  const authority = keypairFromConfig(
    config.DEMO_AUTHORITY_KEYPAIR,
    "DEMO_AUTHORITY_KEYPAIR",
  );
  const feePayer = keypairFromConfig(
    config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  while (!signal.aborted) {
    const messages = await claimOutboxBatch(
      pool,
      ["demo.goal", "demo.complete"],
      20,
    );
    if (messages.length === 0) {
      await delay(250, signal);
      continue;
    }
    for (const message of messages) {
      try {
        if (message.eventType === "demo.goal")
          await openDemo(
            config,
            pool,
            connection,
            authority,
            feePayer,
            message,
          );
        else await requestCompletion(pool, message);
        await markOutboxPublished(pool, message.id);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "unknown demo error";
        logger.error(
          { outboxId: message.id.toString(), reason },
          "demo command failed",
        );
        await deferOutbox(pool, message.id, reason);
      }
    }
  }
}

async function openDemo(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  authority: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  message: OutboxMessage,
): Promise<void> {
  const payload = goalPayload.parse(message.payload);
  if (payload.campaign !== config.DEMO_CAMPAIGN)
    throw new Error("demo command is not for the predetermined campaign");
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const campaignAddress = new PublicKey(payload.campaign);
  const campaignInfo = await connection.getAccountInfo(
    campaignAddress,
    "confirmed",
  );
  if (!campaignInfo || !campaignInfo.owner.equals(programId))
    throw new Error("demo campaign account is absent");
  const campaign = decodeCampaignAccount(campaignInfo.data);
  if (campaign.nextRound >= campaign.roundCount)
    throw new Error("demo campaign has no reward round remaining");
  const eventHash = sha256(
    new TextEncoder().encode(
      `GOALDROP_DEMO_V1:${payload.campaign}:${payload.step}:${message.id}`,
    ),
  );
  const rawDigest = sha256(
    new TextEncoder().encode(`synthetic-devnet-goal:${payload.step}`),
  );
  const [configAddress] = configPda(programId);
  const [roundAddress] = roundPda(
    programId,
    campaignAddress,
    campaign.nextRound,
  );
  const [goalReceipt] = goalReceiptPda(programId, campaignAddress, eventHash);
  let signature: string | undefined;
  if (!(await connection.getAccountInfo(goalReceipt, "confirmed"))) {
    const ix = openDemoRoundInstruction(
      programId,
      {
        config: configAddress,
        demoAuthority: authority.publicKey,
        feePayer: feePayer.publicKey,
        campaign: campaignAddress,
        round: roundAddress,
        goalReceipt,
      },
      {
        fixtureId: campaign.fixtureId,
        eventHash,
        demoNonce: message.id,
        providerTsMs: BigInt(Date.now()),
        rawDigest,
      },
    );
    try {
      signature = (
        await sendWorkerTransaction({
          config,
          pool,
          connection,
          purpose: "open_demo_round",
          aggregateKey: message.id.toString(),
          instructions: [ix],
          feePayer,
          authority,
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
  }
  const roundData = await waitForAccount(connection, roundAddress);
  if (!roundData) throw new Error("synthetic round was not confirmed");
  const round = decodeRoundAccount(roundData);
  const slot = await connection.getSlot("confirmed");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO round_projections (
         round, campaign, ordinal, source, event_key, opened_at, closes_at, reward_amount,
         winner_cap, winner_count, next_chain_sequence, skipped_count, paid_total, state, last_slot, commitment
       ) VALUES ($1,$2,$3,'demo',$4,to_timestamp($5),to_timestamp($6),$7,$8,$9,$10,$11,$12,'open',$13,'confirmed')
       ON CONFLICT (round) DO UPDATE SET state = EXCLUDED.state, last_slot = EXCLUDED.last_slot, commitment = EXCLUDED.commitment,
         updated_at = clock_timestamp()`,
      [
        roundAddress.toBase58(),
        payload.campaign,
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
      `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
       VALUES ($1,'goal.detected',$2::jsonb,$3), ($1,'round.opened',$4::jsonb,$3)`,
      [
        payload.campaign,
        JSON.stringify({
          campaign: payload.campaign,
          source: "demo",
          label: payload.label,
          step: payload.step,
        }),
        message.traceId,
        JSON.stringify({
          round: roundAddress.toBase58(),
          ordinal: round.ordinal,
          source: "demo",
          label: payload.label,
          openedAt: Number(round.openedAt),
          closesAt: Number(round.closesAt),
          rewardAmount: round.rewardAmount.toString(),
          winnerCap: round.winnerCap,
          transactionSignature: signature ?? null,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requestCompletion(
  pool: DatabasePool,
  message: OutboxMessage,
): Promise<void> {
  const payload = completePayload.parse(message.payload);
  await pool.query(
    `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
     VALUES ('campaign',$1,'match.complete',$2::jsonb,$3)`,
    [
      payload.campaign,
      JSON.stringify({
        campaign: payload.campaign,
        fixtureId: "0",
        seq: "0",
        demo: true,
      }),
      message.traceId,
    ],
  );
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

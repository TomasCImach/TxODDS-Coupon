import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { CampaignState, RoundSource, TerminalReason } from "@goaldrop/protocol";
import {
  claimOutboxBatch,
  deferOutbox,
  markOutboxPublished,
  type DatabasePool,
  type OutboxMessage,
} from "@goaldrop/db";
import {
  campaignPda,
  configPda,
  createCampaignInstruction,
  decodeCampaignAccount,
  decodeRoundAccount,
  fixtureSlotPda,
  fundCampaignInstruction,
  goalReceiptPda,
  makeRefundableInstruction,
  openDemoRoundInstruction,
  refundCampaignInstruction,
  releaseFixtureSlotInstruction,
  roundPda,
  sponsorCampaignInstruction,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
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
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}
const preparePayload = z.object({ generation: z.string().regex(/^\d+$/) });
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
  const operator = keypairFromConfig(
    config.OPERATOR_KEYPAIR,
    "OPERATOR_KEYPAIR",
  );
  await registerConfiguredCampaign(config, pool, connection, operator).catch(
    (error: unknown) =>
      logger.warn(
        { reason: safeMessage(error) },
        "legacy demo campaign registration failed",
      ),
  );
  let nextCleanupAt = 0;
  while (!signal.aborted) {
    if (Date.now() >= nextCleanupAt) {
      await reclaimRetiredCampaigns(
        config,
        pool,
        connection,
        operator,
        feePayer,
      ).catch((error: unknown) =>
        logger.warn(
          { reason: safeMessage(error) },
          "retired demo campaign cleanup deferred",
        ),
      );
      nextCleanupAt = Date.now() + 15_000;
    }
    const messages = await claimOutboxBatch(
      pool,
      ["demo.prepare", "demo.goal", "demo.complete"],
      20,
    );
    if (messages.length === 0) {
      await delay(250, signal);
      continue;
    }
    for (const message of messages) {
      try {
        if (message.eventType === "demo.prepare")
          await prepareDemoCampaign(
            config,
            pool,
            connection,
            operator,
            feePayer,
            message,
          );
        else if (message.eventType === "demo.goal")
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
        if (message.eventType === "demo.prepare")
          await markPreparationFailed(pool, message, reason);
        await deferOutbox(pool, message.id, reason);
      }
    }
  }
}

interface DemoCampaignPlan {
  generation: bigint;
  campaign: string;
  fixtureId: bigint;
  campaignNonce: bigint;
}

export function demoCampaignTimes(
  nowSeconds: number,
  lifetimeSeconds: number,
): {
  registrationDeadline: bigint;
  scheduledStart: bigint;
  expectedEnd: bigint;
  hardExpiry: bigint;
} {
  if (!Number.isInteger(nowSeconds) || !Number.isInteger(lifetimeSeconds))
    throw new Error("demo campaign time inputs must be integers");
  if (lifetimeSeconds < 14_400 || lifetimeSeconds > 82_800)
    throw new Error("demo campaign lifetime is outside the safe range");
  return {
    registrationDeadline: BigInt(nowSeconds + lifetimeSeconds - 10_800),
    scheduledStart: BigInt(nowSeconds + lifetimeSeconds - 7_200),
    expectedEnd: BigInt(nowSeconds + lifetimeSeconds - 3_600),
    hardExpiry: BigInt(nowSeconds + lifetimeSeconds),
  };
}

async function prepareDemoCampaign(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  operator: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  message: OutboxMessage,
): Promise<void> {
  const payload = preparePayload.parse(message.payload);
  const generation = BigInt(payload.generation);
  const current = await pool.query<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM demo_runtime
       WHERE singleton AND generation = $1 AND status IN ('preparing','failed')
     ) AS current`,
    [generation.toString()],
  );
  if (!current.rows[0]?.current) return;
  await pool.query(
    `UPDATE demo_runtime SET status = 'preparing', last_error = NULL,
       updated_at = clock_timestamp()
     WHERE singleton AND generation = $1`,
    [generation.toString()],
  );

  const plan = await loadOrCreatePlan(pool, config, operator, generation);
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const rewardMint = new PublicKey(config.GOALDROP_REWARD_MINT);
  const campaignAddress = new PublicKey(plan.campaign);
  const [derivedCampaign] = campaignPda(
    programId,
    operator.publicKey,
    plan.campaignNonce,
  );
  if (!derivedCampaign.equals(campaignAddress))
    throw new Error("stored demo campaign plan has an invalid address");
  const [configAddress] = configPda(programId);
  const [fixtureSlot] = fixtureSlotPda(programId, plan.fixtureId);
  const [vault] = vaultPda(programId, campaignAddress);
  const rounds = Array.from({ length: config.DEMO_ROUND_COUNT }, () => ({
    rewardAmount: config.DEMO_REWARD_AMOUNT_BASE_UNITS,
    winnerCap: config.DEMO_WINNER_CAP,
  }));
  const requiredFunding =
    config.DEMO_REWARD_AMOUNT_BASE_UNITS *
    BigInt(config.DEMO_WINNER_CAP) *
    BigInt(config.DEMO_ROUND_COUNT);

  let campaignInfo = await connection.getAccountInfo(
    campaignAddress,
    "confirmed",
  );
  if (!campaignInfo) {
    if (await connection.getAccountInfo(fixtureSlot, "confirmed"))
      throw new Error("generated demo fixture is unexpectedly reserved");
    const times = demoCampaignTimes(
      Math.floor(Date.now() / 1_000),
      config.DEMO_CAMPAIGN_LIFETIME_SECONDS,
    );
    await sendWorkerTransaction({
      config,
      pool,
      connection,
      purpose: "create_demo_campaign",
      aggregateKey: plan.campaign,
      instructions: [
        createCampaignInstruction(
          programId,
          {
            config: configAddress,
            sponsor: operator.publicKey,
            feePayer: feePayer.publicKey,
            refundWallet: operator.publicKey,
            rewardMint,
            fixtureSlot,
            campaign: campaignAddress,
            vault,
          },
          {
            fixtureId: plan.fixtureId,
            campaignNonce: plan.campaignNonce,
            ...times,
            rounds,
          },
        ),
      ],
      feePayer,
      authority: operator,
      compute: { units: 220_000, microLamports: 1_000 },
      traceId: message.traceId,
    });
    await touchPreparation(pool, generation);
    campaignInfo = await connection.getAccountInfo(
      campaignAddress,
      "confirmed",
    );
  }
  if (!campaignInfo || !campaignInfo.owner.equals(programId))
    throw new Error("new demo campaign was not confirmed");
  let campaign = decodeCampaignAccount(campaignInfo.data);
  assertDemoCampaignFields(
    campaign,
    operator.publicKey,
    rewardMint,
    plan,
    requiredFunding,
  );

  const sponsorSource = getAssociatedTokenAddressSync(
    rewardMint,
    operator.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  if (campaign.state === CampaignState.Draft) {
    await ensureSponsorTokens(
      config,
      pool,
      connection,
      operator,
      feePayer,
      rewardMint,
      sponsorSource,
      requiredFunding,
      message.traceId,
    );
    await sendWorkerTransaction({
      config,
      pool,
      connection,
      purpose: "fund_demo_campaign",
      aggregateKey: plan.campaign,
      instructions: [
        fundCampaignInstruction(
          programId,
          {
            config: configAddress,
            sponsor: operator.publicKey,
            campaign: campaignAddress,
            sponsorSource,
            rewardMint,
            vault,
          },
          requiredFunding,
        ),
      ],
      feePayer,
      authority: operator,
      compute: { units: 120_000, microLamports: 1_000 },
      traceId: message.traceId,
    });
    await touchPreparation(pool, generation);
    campaign = await readCampaign(connection, programId, campaignAddress);
  }
  if (campaign.state === CampaignState.Funded) {
    await sendWorkerTransaction({
      config,
      pool,
      connection,
      purpose: "activate_demo_campaign",
      aggregateKey: plan.campaign,
      instructions: [
        sponsorCampaignInstruction(programId, "activate_campaign", {
          config: configAddress,
          sponsor: operator.publicKey,
          campaign: campaignAddress,
          vault,
        }),
      ],
      feePayer,
      authority: operator,
      compute: { units: 80_000, microLamports: 1_000 },
      traceId: message.traceId,
    });
    campaign = await readCampaign(connection, programId, campaignAddress);
  }
  assertDemoCampaignFields(
    campaign,
    operator.publicKey,
    rewardMint,
    plan,
    requiredFunding,
  );
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (
    campaign.state !== CampaignState.Active ||
    campaign.terminalReason !== TerminalReason.None ||
    campaign.nextRound >= campaign.roundCount ||
    campaign.registrationDeadline <= now + 900n ||
    campaign.hardExpiry <= now + 1_200n
  )
    throw new Error("prepared demo campaign is not safely usable");

  const slot = await connection.getSlot("confirmed");
  await projectCampaign(pool, campaignAddress, campaign, slot);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runtime = await client.query<{ generation: string }>(
      `SELECT generation::text FROM demo_runtime
       WHERE singleton AND generation = $1 AND status = 'preparing' FOR UPDATE`,
      [generation.toString()],
    );
    if (runtime.rows.length === 0) {
      await client.query(
        `UPDATE demo_campaigns SET status = 'retiring', is_current = false,
           updated_at = clock_timestamp() WHERE campaign = $1`,
        [plan.campaign],
      );
    } else {
      await client.query(
        `UPDATE demo_campaigns SET is_current = false,
           status = CASE WHEN status = 'ready' THEN 'retiring' ELSE status END,
           updated_at = clock_timestamp()
         WHERE is_current AND campaign <> $1`,
        [plan.campaign],
      );
      await client.query(
        `UPDATE demo_campaigns SET status = 'ready', is_current = true,
           error_detail = NULL, updated_at = clock_timestamp()
         WHERE campaign = $1`,
        [plan.campaign],
      );
      await client.query(
        `UPDATE demo_runtime SET status = 'ready', campaign = $1,
           last_error = NULL, updated_at = clock_timestamp()
         WHERE singleton AND generation = $2`,
        [plan.campaign, generation.toString()],
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

async function loadOrCreatePlan(
  pool: DatabasePool,
  config: ServiceConfig,
  operator: ReturnType<typeof keypairFromConfig>,
  generation: bigint,
): Promise<DemoCampaignPlan> {
  const existing = await readPlan(pool, generation);
  if (existing) return existing;
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fixtureId = randomPositiveU63();
    const campaignNonce = randomPositiveU64();
    const [campaign] = campaignPda(
      programId,
      operator.publicKey,
      campaignNonce,
    );
    const inserted = await pool.query<{
      campaign: string;
      generation: string;
      fixture_id: string;
      campaign_nonce: string;
    }>(
      `INSERT INTO demo_campaigns (
         campaign, generation, fixture_id, campaign_nonce, status
       ) VALUES ($1,$2,$3,$4,'preparing')
       ON CONFLICT DO NOTHING
       RETURNING campaign, generation::text, fixture_id::text, campaign_nonce::text`,
      [
        campaign.toBase58(),
        generation.toString(),
        fixtureId.toString(),
        campaignNonce.toString(),
      ],
    );
    const row = inserted.rows[0];
    if (row) return planFromRow(row);
    const concurrent = await readPlan(pool, generation);
    if (concurrent) return concurrent;
  }
  throw new Error("could not allocate a unique demo campaign plan");
}

async function readPlan(
  pool: DatabasePool,
  generation: bigint,
): Promise<DemoCampaignPlan | null> {
  const result = await pool.query<{
    campaign: string;
    generation: string;
    fixture_id: string;
    campaign_nonce: string;
  }>(
    `SELECT campaign, generation::text, fixture_id::text, campaign_nonce::text
     FROM demo_campaigns WHERE generation = $1`,
    [generation.toString()],
  );
  return result.rows[0] ? planFromRow(result.rows[0]) : null;
}

function planFromRow(row: {
  campaign: string;
  generation: string;
  fixture_id: string;
  campaign_nonce: string;
}): DemoCampaignPlan {
  return {
    campaign: row.campaign,
    generation: BigInt(row.generation),
    fixtureId: BigInt(row.fixture_id),
    campaignNonce: BigInt(row.campaign_nonce),
  };
}

async function ensureSponsorTokens(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  operator: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  rewardMint: PublicKey,
  sponsorSource: PublicKey,
  requiredFunding: bigint,
  traceId: string,
): Promise<void> {
  const [mint, sourceInfo] = await Promise.all([
    getMint(connection, rewardMint, "confirmed", TOKEN_PROGRAM_ID),
    connection.getAccountInfo(sponsorSource, "confirmed"),
  ]);
  const source = sourceInfo
    ? await getAccount(connection, sponsorSource, "confirmed", TOKEN_PROGRAM_ID)
    : null;
  const available = source?.amount ?? 0n;
  const shortfall =
    requiredFunding > available ? requiredFunding - available : 0n;
  if (shortfall > 0n && !mint.mintAuthority?.equals(operator.publicKey))
    throw new Error("operator is not the Devnet GOAL mint authority");
  const instructions = [];
  if (!sourceInfo)
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        feePayer.publicKey,
        sponsorSource,
        operator.publicKey,
        rewardMint,
      ),
    );
  if (shortfall > 0n)
    instructions.push(
      createMintToCheckedInstruction(
        rewardMint,
        sponsorSource,
        operator.publicKey,
        shortfall,
        mint.decimals,
      ),
    );
  if (instructions.length === 0) return;
  await sendWorkerTransaction({
    config,
    pool,
    connection,
    purpose: "prepare_demo_tokens",
    aggregateKey: sponsorSource.toBase58(),
    instructions,
    feePayer,
    authority: operator,
    compute: { units: 80_000, microLamports: 1_000 },
    traceId,
  });
}

async function projectCampaign(
  pool: DatabasePool,
  address: PublicKey,
  campaign: ReturnType<typeof decodeCampaignAccount>,
  slot: number,
): Promise<void> {
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO campaign_projections (
         campaign, fixture_id, sponsor, state, reward_mint, refund_wallet,
         scheduled_start, registration_deadline, expected_end, hard_expiry,
         terminal_reason, required_funding, funded_amount, paid_amount,
         refunded_amount, external_inflow_total, last_slot, commitment
       ) VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8),to_timestamp($9),to_timestamp($10),
                 $11,$12,$13,$14,$15,$16,$17,'confirmed')
       ON CONFLICT (campaign) DO UPDATE SET state = EXCLUDED.state,
         terminal_reason = EXCLUDED.terminal_reason, funded_amount = EXCLUDED.funded_amount,
         paid_amount = EXCLUDED.paid_amount, refunded_amount = EXCLUDED.refunded_amount,
         external_inflow_total = EXCLUDED.external_inflow_total, last_slot = EXCLUDED.last_slot,
         commitment = EXCLUDED.commitment, updated_at = clock_timestamp()`,
      [
        address.toBase58(),
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
      const round = campaign.rounds[ordinal];
      if (!round) continue;
      await client.query(
        `INSERT INTO campaign_round_configs (campaign, ordinal, reward_amount, winner_cap)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (campaign, ordinal) DO UPDATE SET
           reward_amount = EXCLUDED.reward_amount, winner_cap = EXCLUDED.winner_cap,
           updated_at = clock_timestamp()`,
        [
          address.toBase58(),
          ordinal,
          round.rewardAmount.toString(),
          round.winnerCap,
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

async function registerConfiguredCampaign(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  operator: ReturnType<typeof keypairFromConfig>,
): Promise<void> {
  if (!config.DEMO_CAMPAIGN) return;
  const address = new PublicKey(config.DEMO_CAMPAIGN);
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info?.owner.equals(programId)) return;
  const campaign = decodeCampaignAccount(info.data);
  if (
    !campaign.sponsor.equals(operator.publicKey) ||
    !campaign.rewardMint.equals(new PublicKey(config.GOALDROP_REWARD_MINT))
  )
    return;
  await pool.query(
    `INSERT INTO demo_campaigns (
       campaign, generation, fixture_id, campaign_nonce, status, is_current
     ) VALUES ($1,0,$2,$3,'retiring',false)
     ON CONFLICT (campaign) DO NOTHING`,
    [
      address.toBase58(),
      campaign.fixtureId.toString(),
      campaign.campaignNonce.toString(),
    ],
  );
}

async function reclaimRetiredCampaigns(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  operator: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
): Promise<void> {
  const rows = await pool.query<{ campaign: string }>(
    `SELECT campaign FROM demo_campaigns
     WHERE NOT is_current AND (
       status = 'retiring' OR
       (status = 'failed' AND generation <> (SELECT generation FROM demo_runtime WHERE singleton))
     )
     ORDER BY updated_at LIMIT 8`,
  );
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const rewardMint = new PublicKey(config.GOALDROP_REWARD_MINT);
  for (const row of rows.rows) {
    const address = new PublicKey(row.campaign);
    let info = await connection.getAccountInfo(address, "confirmed");
    if (!info?.owner.equals(programId)) continue;
    let campaign = decodeCampaignAccount(info.data);
    const [vault] = vaultPda(programId, address);
    if (
      (campaign.state === CampaignState.Draft ||
        campaign.state === CampaignState.Funded) &&
      campaign.nextRound === 0 &&
      campaign.openRoundCount === 0 &&
      campaign.sponsor.equals(operator.publicKey)
    ) {
      const [configAddress] = configPda(programId);
      await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "cancel_retired_demo_campaign",
        aggregateKey: row.campaign,
        instructions: [
          sponsorCampaignInstruction(programId, "cancel_campaign", {
            config: configAddress,
            sponsor: operator.publicKey,
            campaign: address,
            vault,
          }),
        ],
        feePayer,
        authority: operator,
        compute: { units: 70_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
      campaign = await readCampaign(connection, programId, address);
    }
    if (
      (campaign.state === CampaignState.Cancelled ||
        (campaign.state === CampaignState.Active &&
          campaign.terminalReason !== TerminalReason.None)) &&
      campaign.openRoundCount === 0
    ) {
      await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "make_retired_demo_refundable",
        aggregateKey: row.campaign,
        instructions: [makeRefundableInstruction(programId, address, vault)],
        feePayer,
        compute: { units: 80_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
      campaign = await readCampaign(connection, programId, address);
    }
    if (campaign.state === CampaignState.Refundable) {
      const refundToken = getAssociatedTokenAddressSync(
        rewardMint,
        campaign.refundWallet,
        true,
        TOKEN_PROGRAM_ID,
      );
      await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "refund_retired_demo_campaign",
        aggregateKey: row.campaign,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(
            feePayer.publicKey,
            refundToken,
            campaign.refundWallet,
            rewardMint,
          ),
          refundCampaignInstruction(programId, {
            campaign: address,
            vault,
            rewardMint,
            refundWallet: campaign.refundWallet,
            refundToken,
          }),
        ],
        feePayer,
        compute: { units: 120_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
      campaign = await readCampaign(connection, programId, address);
    }
    if (campaign.state !== CampaignState.Refunded) continue;
    if (await connection.getAccountInfo(campaign.fixtureSlot, "confirmed")) {
      await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "release_retired_demo_fixture",
        aggregateKey: row.campaign,
        instructions: [
          releaseFixtureSlotInstruction(programId, {
            campaign: address,
            fixtureSlot: campaign.fixtureSlot,
            rentRecipient: campaign.refundWallet,
          }),
        ],
        feePayer,
        compute: { units: 50_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
    }
    const slot = await connection.getSlot("confirmed");
    await projectCampaign(pool, address, campaign, slot);
    await pool.query(
      `UPDATE demo_campaigns SET status = 'retired', is_current = false,
         error_detail = NULL, updated_at = clock_timestamp()
       WHERE campaign = $1`,
      [row.campaign],
    );
  }
}

async function markPreparationFailed(
  pool: DatabasePool,
  message: OutboxMessage,
  reason: string,
): Promise<void> {
  const payload = preparePayload.safeParse(message.payload);
  if (!payload.success) return;
  await pool.query(
    `UPDATE demo_runtime SET status = 'failed', campaign = NULL,
       last_error = left($2,500), updated_at = clock_timestamp()
     WHERE singleton AND generation = $1`,
    [payload.data.generation, reason],
  );
  await pool.query(
    `UPDATE demo_campaigns SET status = 'failed', is_current = false,
       error_detail = left($2,500), updated_at = clock_timestamp()
     WHERE generation = $1`,
    [payload.data.generation, reason],
  );
}

async function touchPreparation(
  pool: DatabasePool,
  generation: bigint,
): Promise<void> {
  await pool.query(
    `UPDATE demo_runtime SET updated_at = clock_timestamp()
     WHERE singleton AND generation = $1 AND status = 'preparing'`,
    [generation.toString()],
  );
}

async function readCampaign(
  connection: ReturnType<typeof connectionFor>,
  programId: PublicKey,
  address: PublicKey,
): Promise<ReturnType<typeof decodeCampaignAccount>> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info?.owner.equals(programId))
    throw new Error("demo campaign readback failed");
  return decodeCampaignAccount(info.data);
}

function assertDemoCampaignFields(
  campaign: ReturnType<typeof decodeCampaignAccount>,
  operator: PublicKey,
  rewardMint: PublicKey,
  plan: DemoCampaignPlan,
  requiredFunding: bigint,
): void {
  if (
    !campaign.sponsor.equals(operator) ||
    !campaign.refundWallet.equals(operator) ||
    !campaign.rewardMint.equals(rewardMint) ||
    campaign.fixtureId !== plan.fixtureId ||
    campaign.campaignNonce !== plan.campaignNonce ||
    campaign.requiredFunding !== requiredFunding
  )
    throw new Error("demo campaign fields do not match its preparation plan");
}

function randomPositiveU63(): bigint {
  const value = randomBytes(8).readBigUInt64LE() & 0x7fff_ffff_ffff_ffffn;
  return value === 0n ? 1n : value;
}

function randomPositiveU64(): bigint {
  const value = randomBytes(8).readBigUInt64LE();
  return value === 0n ? 1n : value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown demo error";
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
  const managed = await pool.query<{ managed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM demo_campaigns WHERE campaign = $1
     ) AS managed`,
    [payload.campaign],
  );
  if (!managed.rows[0]?.managed && payload.campaign !== config.DEMO_CAMPAIGN)
    throw new Error("demo command is not for a managed demo campaign");
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const campaignAddress = new PublicKey(payload.campaign);
  const campaignInfo = await connection.getAccountInfo(
    campaignAddress,
    "confirmed",
  );
  if (!campaignInfo || !campaignInfo.owner.equals(programId))
    throw new Error("demo campaign account is absent");
  const campaign = decodeCampaignAccount(campaignInfo.data);
  const eventHash = sha256(
    new TextEncoder().encode(
      `GOALDROP_DEMO_V1:${payload.campaign}:${payload.step}:${message.id}`,
    ),
  );
  const rawDigest = sha256(
    new TextEncoder().encode(`synthetic-devnet-goal:${payload.step}`),
  );
  const [configAddress] = configPda(programId);
  const [goalReceipt] = goalReceiptPda(programId, campaignAddress, eventHash);
  const receiptInfo = await connection.getAccountInfo(goalReceipt, "confirmed");
  const resolved = resolveGoalRound({
    programId,
    campaignAddress,
    campaign,
    eventHash,
    expectedSource: RoundSource.Demo,
    receiptInfo,
  });
  if (!resolved) throw new Error("demo campaign has no reward round remaining");
  const [roundAddress] = roundPda(programId, campaignAddress, resolved.ordinal);
  let signature: string | undefined;
  if (!resolved.alreadyOpened) {
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

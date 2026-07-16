import { randomUUID } from "node:crypto";
import {
  claimOutboxBatch,
  deferOutbox,
  markOutboxPublished,
  type DatabasePool,
  type OutboxMessage,
} from "@goaldrop/db";
import {
  CampaignState,
  canonicalizeIntent,
  IntentAction,
  intentHash,
  RoundState,
  TerminalReason,
  verifyIntentSignature,
} from "@goaldrop/protocol";
import {
  claimPda,
  closeRoundInstruction,
  configPda,
  decodeRoundAccount,
  fanSignatureVerificationInstruction,
  decodeCampaignAccount,
  finalizeAfterTimeoutInstruction,
  makeRefundableInstruction,
  registrationPda,
  registerFanInstruction,
  releaseFixtureSlotInstruction,
  roundPda,
  settleClaimInstruction,
  skipSequenceInstruction,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { ServiceConfig } from "../config.js";
import {
  connectionFor,
  keypairFromConfig,
  sendWorkerTransaction,
  tokenDelta,
  waitForAccount,
} from "./solana.js";

interface WorkerLogger {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

const registrationPayload = z.object({
  registrationId: z.string().uuid(),
  campaign: z.string(),
  wallet: z.string(),
});
const claimPayload = z.object({
  receiptId: z.string().uuid(),
  campaign: z.string(),
  round: z.string(),
  wallet: z.string(),
  sequence: z.string(),
});

export async function runSettlementWorker(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: WorkerLogger,
  signal: AbortSignal,
): Promise<void> {
  const connection = connectionFor(config);
  const relayer = keypairFromConfig(config.RELAYER_KEYPAIR, "RELAYER_KEYPAIR");
  const feePayer = keypairFromConfig(
    config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  let nextLifecycleAt = 0;
  while (!signal.aborted) {
    if (Date.now() >= nextLifecycleAt) {
      try {
        await processLifecycle(config, pool, connection, feePayer);
      } catch (error) {
        logger.error(
          {
            reason: error instanceof Error ? error.message : "lifecycle error",
          },
          "campaign lifecycle sweep failed",
        );
      }
      nextLifecycleAt = Date.now() + 2_000;
    }
    const messages = await claimOutboxBatch(
      pool,
      ["registration.accepted", "claim.accepted"],
      50,
    );
    if (messages.length === 0) {
      await delay(200, signal);
      continue;
    }
    for (const message of messages) {
      try {
        if (message.eventType === "registration.accepted") {
          await processRegistration(
            config,
            pool,
            connection,
            relayer,
            feePayer,
            message,
          );
        } else {
          const payload = claimPayload.parse(message.payload);
          await withRoundLock(pool, payload.round, () =>
            processRound(
              config,
              pool,
              connection,
              relayer,
              feePayer,
              payload.round,
            ),
          );
        }
        await markOutboxPublished(pool, message.id);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "unknown settlement error";
        logger.error(
          {
            outboxId: message.id.toString(),
            eventType: message.eventType,
            attempts: message.attempts,
            reason,
          },
          "settlement command failed",
        );
        await deferOutbox(pool, message.id, reason);
      }
    }
  }
}

async function processLifecycle(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  feePayer: ReturnType<typeof keypairFromConfig>,
): Promise<void> {
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const expiredRounds = await pool.query<{ round: string; campaign: string }>(
    `SELECT round, campaign FROM round_projections
     WHERE state = 'open' AND closes_at <= clock_timestamp() ORDER BY closes_at LIMIT 25`,
  );
  for (const row of expiredRounds.rows) {
    const address = new PublicKey(row.round);
    const info = await connection.getAccountInfo(address, "confirmed");
    if (!info || !info.owner.equals(programId)) continue;
    const round = decodeRoundAccount(info.data);
    if (
      round.state === RoundState.Open &&
      round.closesAt <= BigInt(Math.floor(Date.now() / 1_000))
    ) {
      await closeExpiredRound(
        config,
        pool,
        connection,
        feePayer,
        new PublicKey(row.campaign),
        address,
      );
    }
    const current = await connection.getAccountInfo(address, "confirmed");
    if (current) {
      const projected = decodeRoundAccount(current.data);
      await projectRound(
        pool,
        address,
        projected,
        await connection.getSlot("confirmed"),
      );
      if (projected.state !== RoundState.Open)
        await markRemaining(
          pool,
          row.round,
          projected.state === RoundState.Exhausted ? "missed" : "expired",
        );
    }
  }

  const campaigns = await pool.query<{ campaign: string }>(
    `SELECT campaign FROM campaign_projections
     WHERE state IN ('active','cancelled','refunded')
       AND (terminal_reason <> 'none' OR hard_expiry <= clock_timestamp() OR state <> 'active')
     ORDER BY updated_at LIMIT 25`,
  );
  for (const row of campaigns.rows) {
    const address = new PublicKey(row.campaign);
    let info = await connection.getAccountInfo(address, "confirmed");
    if (!info || !info.owner.equals(programId)) continue;
    let campaign = decodeCampaignAccount(info.data);
    if (
      campaign.state === CampaignState.Active &&
      campaign.terminalReason === TerminalReason.None &&
      campaign.hardExpiry <= BigInt(Math.floor(Date.now() / 1_000))
    ) {
      const result = await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "finalize_after_timeout",
        aggregateKey: row.campaign,
        instructions: [finalizeAfterTimeoutInstruction(programId, address)],
        feePayer,
        compute: { units: 60_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
      await pool.query(
        `UPDATE campaign_projections SET terminal_reason = 'hard_timeout', updated_at = clock_timestamp() WHERE campaign = $1`,
        [row.campaign],
      );
      await pool.query(
        `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
         VALUES ($1,'campaign.updated',$2::jsonb,$3)`,
        [
          row.campaign,
          JSON.stringify({
            campaign: row.campaign,
            terminalReason: "hard_timeout",
            transactionSignature: result.signature,
          }),
          randomUUID(),
        ],
      );
      info = await connection.getAccountInfo(address, "confirmed");
      if (!info) continue;
      campaign = decodeCampaignAccount(info.data);
    }
    const terminal =
      campaign.state === CampaignState.Cancelled ||
      (campaign.state === CampaignState.Active &&
        campaign.terminalReason !== TerminalReason.None);
    if (terminal && campaign.openRoundCount === 0) {
      const [vault] = vaultPda(programId, address);
      const result = await sendWorkerTransaction({
        config,
        pool,
        connection,
        purpose: "make_refundable",
        aggregateKey: row.campaign,
        instructions: [makeRefundableInstruction(programId, address, vault)],
        feePayer,
        compute: { units: 80_000, microLamports: 1_000 },
        traceId: randomUUID(),
      });
      await pool.query(
        `UPDATE campaign_projections SET state = 'refundable', updated_at = clock_timestamp() WHERE campaign = $1`,
        [row.campaign],
      );
      await pool.query(
        `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
         VALUES ($1,'campaign.refundable',$2::jsonb,$3)`,
        [
          row.campaign,
          JSON.stringify({
            campaign: row.campaign,
            transactionSignature: result.signature,
          }),
          randomUUID(),
        ],
      );
    } else if (campaign.state === CampaignState.Refunded) {
      const fixture = await connection.getAccountInfo(
        campaign.fixtureSlot,
        "confirmed",
      );
      if (fixture) {
        await sendWorkerTransaction({
          config,
          pool,
          connection,
          purpose: "release_fixture_slot",
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
    }
  }
}

async function processRegistration(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  relayer: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  message: OutboxMessage,
): Promise<void> {
  const payload = registrationPayload.parse(message.payload);
  const rowResult = await pool.query<{
    campaign: string;
    wallet: string;
    intent_hash: Buffer;
    fan_signature: Buffer;
    nonce: Buffer;
    expires_at: Date;
    status: string;
  }>(
    "SELECT campaign, wallet, intent_hash, fan_signature, nonce, expires_at, status FROM registration_requests WHERE id = $1",
    [payload.registrationId],
  );
  const row = rowResult.rows[0];
  if (!row) throw new Error("registration request not found");
  if (["confirmed", "finalized"].includes(row.status)) return;
  if (row.expires_at.getTime() <= Date.now()) {
    await pool.query(
      "UPDATE registration_requests SET status = 'expired', error_code = 'intent_expired', updated_at = clock_timestamp() WHERE id = $1",
      [payload.registrationId],
    );
    return;
  }
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const campaign = new PublicKey(row.campaign);
  const wallet = new PublicKey(row.wallet);
  const [configAddress] = configPda(programId);
  const [registration] = registrationPda(programId, campaign, wallet);
  let signature: string | undefined;
  if (!(await connection.getAccountInfo(registration, "confirmed"))) {
    const ed25519 = fanSignatureVerificationInstruction(
      wallet,
      row.intent_hash,
      row.fan_signature,
    );
    const register = registerFanInstruction(
      programId,
      {
        config: configAddress,
        campaign,
        wallet,
        registration,
        relayer: relayer.publicKey,
        feePayer: feePayer.publicKey,
      },
      {
        nonce: row.nonce,
        expiresAt: BigInt(Math.floor(row.expires_at.getTime() / 1_000)),
        intentHash: row.intent_hash,
      },
    );
    try {
      signature = (
        await sendWorkerTransaction({
          config,
          pool,
          connection,
          purpose: "register_fan",
          aggregateKey: payload.registrationId,
          instructions: [ed25519, register],
          feePayer,
          authority: relayer,
          compute: { units: 160_000, microLamports: 1_000 },
          traceId: message.traceId,
        })
      ).signature;
    } catch (error) {
      if (!(await waitForAccount(connection, registration, 2))) throw error;
      signature = (
        await connection.getSignaturesForAddress(
          registration,
          { limit: 1 },
          "confirmed",
        )
      )[0]?.signature;
    }
  } else {
    signature = (
      await connection.getSignaturesForAddress(
        registration,
        { limit: 1 },
        "confirmed",
      )
    )[0]?.signature;
  }
  const data = await waitForAccount(connection, registration);
  if (!data || data.length !== 128)
    throw new Error("registration PDA is not confirmed with expected layout");
  const slot = await connection.getSlot("confirmed");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO registration_projections (
         campaign, wallet, registration_pda, confirmed_slot, transaction_signature, commitment, registered_at
       ) VALUES ($1,$2,$3,$4,$5,'confirmed',to_timestamp($6))
       ON CONFLICT (campaign, wallet) DO UPDATE SET confirmed_slot = EXCLUDED.confirmed_slot,
         transaction_signature = EXCLUDED.transaction_signature, commitment = EXCLUDED.commitment`,
      [
        row.campaign,
        row.wallet,
        registration.toBase58(),
        slot,
        signature ?? "reconciled",
        data.readBigInt64LE(74).toString(),
      ],
    );
    await client.query(
      "UPDATE registration_requests SET status = 'confirmed', registration_pda = $2, transaction_signature = $3, updated_at = clock_timestamp() WHERE id = $1",
      [payload.registrationId, registration.toBase58(), signature ?? null],
    );
    await client.query(
      "UPDATE campaign_projections SET registration_count = registration_count + 1, updated_at = clock_timestamp() WHERE campaign = $1",
      [row.campaign],
    );
    await client.query(
      `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
       VALUES ($1,'campaign.updated',$2::jsonb,$3)`,
      [
        row.campaign,
        JSON.stringify({
          campaign: row.campaign,
          registration: "confirmed",
          wallet: row.wallet,
          transactionSignature: signature ?? null,
        }),
        message.traceId,
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

async function processRound(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  relayer: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  roundString: string,
): Promise<void> {
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const roundAddress = new PublicKey(roundString);
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const roundInfo = await connection.getAccountInfo(
      roundAddress,
      "confirmed",
    );
    if (!roundInfo || !roundInfo.owner.equals(programId))
      throw new Error("round account is absent or has wrong owner");
    const round = decodeRoundAccount(roundInfo.data);
    if (round.state !== RoundState.Open) {
      await markRemaining(
        pool,
        roundString,
        round.state === RoundState.Exhausted ? "missed" : "expired",
      );
      await projectRound(
        pool,
        roundAddress,
        round,
        await connection.getSlot("confirmed"),
      );
      return;
    }
    if (round.closesAt <= BigInt(Math.floor(Date.now() / 1_000))) {
      await closeExpiredRound(
        config,
        pool,
        connection,
        feePayer,
        round.campaign,
        roundAddress,
      );
      continue;
    }
    const requestResult = await pool.query<{
      receipt_id: string;
      campaign: string;
      wallet: string;
      recipient: string;
      intent_hash: Buffer;
      fan_signature: Buffer;
      nonce: Buffer;
      expires_at: Date;
      sequence: string;
      status: string;
      trace_id: string;
    }>(
      `SELECT receipt_id, campaign, wallet, recipient, intent_hash, fan_signature, nonce,
              expires_at, sequence, status, trace_id
       FROM claim_requests WHERE round = $1 AND sequence = $2 AND status IN ('accepted','submitted')`,
      [roundString, round.nextSequence.toString()],
    );
    const request = requestResult.rows[0];
    if (!request) return;
    if (request.expires_at.getTime() <= Date.now()) {
      await skipExpiredClaim(
        config,
        pool,
        connection,
        relayer,
        feePayer,
        round,
        roundAddress,
        request,
      );
      continue;
    }
    const wallet = new PublicKey(request.wallet);
    const campaign = new PublicKey(request.campaign);
    const fields = canonicalizeIntent({
      programId: programId.toBytes(),
      action: IntentAction.Claim,
      campaign: campaign.toBytes(),
      round: roundAddress.toBytes(),
      wallet: wallet.toBytes(),
      nonce: request.nonce,
      expiresAt: BigInt(Math.floor(request.expires_at.getTime() / 1_000)),
    });
    const computed = intentHash(fields);
    if (
      !Buffer.from(computed).equals(request.intent_hash) ||
      !verifyIntentSignature(fields, request.fan_signature)
    ) {
      throw new Error(
        "stored claim signature failed deterministic revalidation",
      );
    }
    const mint = new PublicKey(config.GOALDROP_REWARD_MINT);
    const recipientToken = getAssociatedTokenAddressSync(
      mint,
      wallet,
      false,
      TOKEN_PROGRAM_ID,
    );
    const [configAddress] = configPda(programId);
    const [registration] = registrationPda(programId, campaign, wallet);
    const [claim] = claimPda(programId, roundAddress, wallet);
    const [vault] = vaultPda(programId, campaign);
    let signature: string | undefined;
    if (!(await connection.getAccountInfo(claim, "confirmed"))) {
      const createAta = createAssociatedTokenAccountIdempotentInstruction(
        feePayer.publicKey,
        recipientToken,
        wallet,
        mint,
        TOKEN_PROGRAM_ID,
      );
      const ed25519 = fanSignatureVerificationInstruction(
        wallet,
        request.intent_hash,
        request.fan_signature,
      );
      const settle = settleClaimInstruction(
        programId,
        {
          config: configAddress,
          campaign,
          round: roundAddress,
          wallet,
          registration,
          claim,
          relayer: relayer.publicKey,
          feePayer: feePayer.publicKey,
          vault,
          rewardMint: mint,
          recipientToken,
        },
        {
          sequence: BigInt(request.sequence),
          nonce: request.nonce,
          expiresAt: BigInt(Math.floor(request.expires_at.getTime() / 1_000)),
          intentHash: request.intent_hash,
        },
      );
      try {
        signature = (
          await sendWorkerTransaction({
            config,
            pool,
            connection,
            purpose: "settle_claim",
            aggregateKey: request.receipt_id,
            instructions: [createAta, ed25519, settle],
            feePayer,
            authority: relayer,
            compute: { units: 260_000, microLamports: 1_000 },
            traceId: request.trace_id,
          })
        ).signature;
      } catch (error) {
        if (!(await waitForAccount(connection, claim, 2))) throw error;
        signature = (
          await connection.getSignaturesForAddress(
            claim,
            { limit: 1 },
            "confirmed",
          )
        )[0]?.signature;
      }
    } else {
      signature = (
        await connection.getSignaturesForAddress(
          claim,
          { limit: 1 },
          "confirmed",
        )
      )[0]?.signature;
    }
    const claimData = await waitForAccount(connection, claim);
    if (!claimData || claimData.length !== 200 || !signature)
      throw new Error("Claim PDA or settlement signature is not confirmed");
    const transaction = await getConfirmedTransaction(connection, signature);
    const paid = tokenDelta(transaction, recipientToken, mint, wallet);
    if (paid !== round.rewardAmount)
      throw new Error(
        "confirmed Claim does not have the exact matching token transfer",
      );
    const [campaignInfoAfter, roundInfoAfter, projectionSlot] =
      await Promise.all([
        connection.getAccountInfo(campaign, "confirmed"),
        connection.getAccountInfo(roundAddress, "confirmed"),
        connection.getSlot("confirmed"),
      ]);
    if (
      !campaignInfoAfter ||
      !campaignInfoAfter.owner.equals(programId) ||
      campaignInfoAfter.data.length !== 424
    )
      throw new Error("campaign readback failed after confirmed Claim");
    if (
      !roundInfoAfter ||
      !roundInfoAfter.owner.equals(programId) ||
      roundInfoAfter.data.length !== 216
    )
      throw new Error("round readback failed after confirmed Claim");
    const campaignAfter = decodeCampaignAccount(campaignInfoAfter.data);
    await projectRound(
      pool,
      roundAddress,
      decodeRoundAccount(roundInfoAfter.data),
      projectionSlot,
    );
    await pool.query(
      `UPDATE campaign_projections SET funded_amount = $2, paid_amount = $3,
         refunded_amount = $4, external_inflow_total = $5, last_slot = $6,
         commitment = 'confirmed', updated_at = clock_timestamp() WHERE campaign = $1`,
      [
        campaign.toBase58(),
        campaignAfter.fundedAmount.toString(),
        campaignAfter.paidAmount.toString(),
        campaignAfter.refundedAmount.toString(),
        campaignAfter.externalInflowTotal.toString(),
        projectionSlot,
      ],
    );
    const winnerRank = claimData.readUInt16LE(10);
    await pool.query(
      `UPDATE claim_requests SET status = 'confirmed', transaction_signature = $2, claim_pda = $3,
         winner_rank = $4, updated_at = clock_timestamp() WHERE receipt_id = $1`,
      [request.receipt_id, signature, claim.toBase58(), winnerRank],
    );
    await pool.query(
      `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
       VALUES ($1,'claim.confirmed',$2::jsonb,$3)`,
      [
        request.campaign,
        JSON.stringify({
          receiptId: request.receipt_id,
          round: roundString,
          wallet: request.wallet,
          winnerRank,
          amount: round.rewardAmount.toString(),
          transactionSignature: signature,
          claimPda: claim.toBase58(),
        }),
        request.trace_id,
      ],
    );
    await pool.query(
      "UPDATE outbox SET published_at = clock_timestamp() WHERE aggregate_key = $1 AND event_type = 'claim.accepted'",
      [request.receipt_id],
    );
  }
}

async function skipExpiredClaim(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  relayer: ReturnType<typeof keypairFromConfig>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  round: ReturnType<typeof decodeRoundAccount>,
  roundAddress: PublicKey,
  request: {
    receipt_id: string;
    campaign: string;
    intent_hash: Buffer;
    sequence: string;
    trace_id: string;
  },
): Promise<void> {
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const [configAddress] = configPda(programId);
  const ix = skipSequenceInstruction(
    programId,
    {
      config: configAddress,
      campaign: new PublicKey(request.campaign),
      round: roundAddress,
      relayer: relayer.publicKey,
    },
    {
      sequence: BigInt(request.sequence),
      intentHash: request.intent_hash,
      reason: 1,
    },
  );
  const { signature } = await sendWorkerTransaction({
    config,
    pool,
    connection,
    purpose: "skip_sequence",
    aggregateKey: request.receipt_id,
    instructions: [ix],
    feePayer,
    authority: relayer,
    compute: { units: 80_000, microLamports: 1_000 },
    traceId: request.trace_id,
  });
  await pool.query(
    "UPDATE claim_requests SET status = 'skipped', transaction_signature = $2, error_code = 'intent_expired_in_queue', updated_at = clock_timestamp() WHERE receipt_id = $1",
    [request.receipt_id, signature],
  );
  await pool.query(
    `INSERT INTO audit_log (actor_type, actor_key, action, target_type, target_key, reason, trace_id)
     VALUES ('worker',$1,'sequence_skip','claim',$2,'accepted intent expired before settlement',$3)`,
    [relayer.publicKey.toBase58(), request.receipt_id, request.trace_id],
  );
}

async function closeExpiredRound(
  config: ServiceConfig,
  pool: DatabasePool,
  connection: ReturnType<typeof connectionFor>,
  feePayer: ReturnType<typeof keypairFromConfig>,
  campaign: PublicKey,
  round: PublicKey,
): Promise<void> {
  const ix = closeRoundInstruction(
    new PublicKey(config.GOALDROP_PROGRAM_ID),
    campaign,
    round,
  );
  await sendWorkerTransaction({
    config,
    pool,
    connection,
    purpose: "close_round",
    aggregateKey: round.toBase58(),
    instructions: [ix],
    feePayer,
    compute: { units: 60_000, microLamports: 1_000 },
    traceId: randomUUID(),
  });
}

async function projectRound(
  pool: DatabasePool,
  address: PublicKey,
  round: ReturnType<typeof decodeRoundAccount>,
  slot: number,
): Promise<void> {
  const states = ["open", "exhausted", "expired"] as const;
  await pool.query(
    `UPDATE round_projections SET winner_count = $2, next_chain_sequence = $3, skipped_count = $4,
       paid_total = $5, state = $6, last_slot = $7, commitment = 'confirmed', updated_at = clock_timestamp()
     WHERE round = $1`,
    [
      address.toBase58(),
      round.winnerCount,
      round.nextSequence.toString(),
      round.skippedCount,
      round.paidTotal.toString(),
      states[round.state] ?? "expired",
      slot,
    ],
  );
}

async function markRemaining(
  pool: DatabasePool,
  round: string,
  status: "missed" | "expired",
): Promise<void> {
  const result = await pool.query<{
    receipt_id: string;
    campaign: string;
    wallet: string;
    trace_id: string;
  }>(
    `UPDATE claim_requests SET status = $2, updated_at = clock_timestamp()
     WHERE round = $1 AND status IN ('accepted','submitted') RETURNING receipt_id, campaign, wallet, trace_id`,
    [round, status],
  );
  for (const row of result.rows) {
    await pool.query(
      `INSERT INTO application_events (campaign, event_type, safe_payload, trace_id)
       VALUES ($1,'claim.missed',$2::jsonb,$3)`,
      [
        row.campaign,
        JSON.stringify({
          receiptId: row.receipt_id,
          round,
          wallet: row.wallet,
          status,
        }),
        row.trace_id,
      ],
    );
  }
}

async function getConfirmedTransaction(
  connection: ReturnType<typeof connectionFor>,
  signature: string,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction) return transaction;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error(
    "confirmed settlement transaction could not be fetched for transfer verification",
  );
}

async function withRoundLock<T>(
  pool: DatabasePool,
  round: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      round,
    ]);
    return await work();
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [round])
      .catch(() => undefined);
    client.release();
  }
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

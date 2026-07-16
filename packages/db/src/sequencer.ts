import {
  createPrivateKey,
  randomUUID,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  DEVNET_NETWORK_DOMAIN,
  encodeReceipt,
  publicKeyBytes,
  receiptHash,
  type CanonicalReceipt,
  type ClaimStatus,
} from "@goaldrop/protocol";
import type { DatabasePool } from "./pool.js";

export interface AcceptClaimInput {
  campaign: string;
  round: string;
  wallet: string;
  recipient: string;
  programId: string;
  intentHash: Uint8Array;
  fanSignature: Uint8Array;
  nonce: Uint8Array;
  expiresAt: Date;
  origin: string;
  authorityEpoch: number;
  relayerPublicKey: Uint8Array;
  relayerSecretKey: Uint8Array;
  traceId?: string;
}

export interface AcceptedClaim {
  receiptId: string;
  sequence: bigint;
  acceptedAt: Date;
  status: ClaimStatus;
  canonicalPayload: Uint8Array;
  receiptSignature: Uint8Array;
  duplicate: boolean;
}

export type BatchClaimAcceptance =
  { ok: true; value: AcceptedClaim } | { ok: false; error: Error };

const privateKeyCache = new Map<string, KeyObject>();

function signReceiptNative(
  receipt: CanonicalReceipt,
  secretKey: Uint8Array,
): Uint8Array {
  if (secretKey.length !== 64)
    throw new Error("relayer secret key must contain 64 bytes");
  const seed = Buffer.from(secretKey.subarray(0, 32));
  const cacheKey = seed.toString("hex");
  let privateKey = privateKeyCache.get(cacheKey);
  if (!privateKey) {
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    privateKeyCache.set(cacheKey, privateKey);
  }
  return new Uint8Array(signEd25519(null, receiptHash(receipt), privateKey));
}

interface ExistingClaimRow {
  receipt_id: string;
  sequence: string;
  accepted_at: Date;
  status: ClaimStatus;
  canonical_payload: Buffer;
  receipt_signature: Buffer;
}

function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));
}

function mapExisting(row: ExistingClaimRow, duplicate: boolean): AcceptedClaim {
  return {
    receiptId: row.receipt_id,
    sequence: BigInt(row.sequence),
    acceptedAt: row.accepted_at,
    status: row.status,
    canonicalPayload: new Uint8Array(row.canonical_payload),
    receiptSignature: new Uint8Array(row.receipt_signature),
    duplicate,
  };
}

export async function claimRequestExists(
  pool: DatabasePool,
  round: string,
  wallet: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM claim_requests WHERE round = $1 AND wallet = $2",
    [round, wallet],
  );
  return result.rowCount === 1;
}

export async function acceptClaim(
  pool: DatabasePool,
  input: AcceptClaimInput,
): Promise<AcceptedClaim> {
  if (input.wallet !== input.recipient)
    throw new Error("recipient must equal wallet");
  if (input.expiresAt.getTime() <= Date.now())
    throw new Error("claim intent expired");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO round_sequences(round) VALUES ($1) ON CONFLICT DO NOTHING",
      [input.round],
    );
    await client.query(
      "SELECT next_sequence FROM round_sequences WHERE round = $1 FOR UPDATE",
      [input.round],
    );
    const existing = await client.query<ExistingClaimRow>(
      `SELECT c.receipt_id, c.sequence, c.accepted_at, c.status,
              r.canonical_payload, r.signature AS receipt_signature
       FROM claim_requests c JOIN receipts r USING (receipt_id)
       WHERE c.round = $1 AND c.wallet = $2`,
      [input.round, input.wallet],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return mapExisting(existing.rows[0], true);
    }
    const eligible = await client.query<{ eligible: boolean }>(
      `SELECT state = 'open' AND commitment IN ('confirmed', 'finalized')
              AND closes_at > clock_timestamp() AND winner_count < winner_cap AS eligible
       FROM round_projections WHERE round = $1 AND campaign = $2 FOR UPDATE`,
      [input.round, input.campaign],
    );
    if (!eligible.rows[0]?.eligible)
      throw new Error("round is not confirmed and open for claims");
    const registration = await client.query(
      `SELECT 1 FROM registration_projections
       WHERE campaign = $1 AND wallet = $2 AND commitment IN ('confirmed', 'finalized')`,
      [input.campaign, input.wallet],
    );
    if (registration.rowCount !== 1)
      throw new Error("fan does not have a confirmed registration");
    const challenge = await client.query(
      `UPDATE intent_challenges SET used_at = clock_timestamp()
       WHERE nonce_hash = $1 AND action = 'claim' AND wallet = $2 AND campaign = $3
         AND round = $4 AND origin = $5 AND used_at IS NULL AND expires_at >= clock_timestamp()
       RETURNING nonce_hash`,
      [
        Buffer.from(sha256(input.nonce)),
        input.wallet,
        input.campaign,
        input.round,
        input.origin,
      ],
    );
    if (challenge.rowCount !== 1)
      throw new Error("claim challenge is invalid, used, or expired");
    const clock = await client.query<{
      accepted_at: Date;
      accepted_at_ms: string;
    }>(
      "SELECT clock_timestamp() AS accepted_at, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS accepted_at_ms",
    );
    const acceptedAt = clock.rows[0]?.accepted_at;
    const acceptedAtMs = clock.rows[0]?.accepted_at_ms;
    if (!acceptedAt || !acceptedAtMs)
      throw new Error("database clock unavailable");
    const allocated = await client.query<{ sequence: string }>(
      `UPDATE round_sequences SET next_sequence = next_sequence + 1, updated_at = clock_timestamp()
       WHERE round = $1 RETURNING next_sequence - 1 AS sequence`,
      [input.round],
    );
    const sequence = BigInt(allocated.rows[0]?.sequence ?? "0");
    if (sequence < 1n) throw new Error("sequence allocation failed");
    const receiptId = randomUUID();
    const receipt: CanonicalReceipt = {
      version: 1,
      authorityEpoch: input.authorityEpoch,
      networkDomain: DEVNET_NETWORK_DOMAIN,
      programId: publicKeyBytes(input.programId),
      campaign: publicKeyBytes(input.campaign),
      round: publicKeyBytes(input.round),
      wallet: publicKeyBytes(input.wallet),
      intentHash: new Uint8Array(input.intentHash),
      sequence,
      acceptedAtMs: BigInt(acceptedAtMs),
      receiptId: uuidBytes(receiptId),
    };
    const canonicalPayload = encodeReceipt(receipt);
    const receiptSignature = signReceiptNative(receipt, input.relayerSecretKey);
    const traceId = input.traceId ?? randomUUID();
    await client.query(
      `INSERT INTO claim_requests (
         receipt_id, campaign, round, wallet, recipient, intent_hash, fan_signature,
         nonce, expires_at, sequence, status, trace_id, accepted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'accepted',$11,$12)`,
      [
        receiptId,
        input.campaign,
        input.round,
        input.wallet,
        input.recipient,
        Buffer.from(input.intentHash),
        Buffer.from(input.fanSignature),
        Buffer.from(input.nonce),
        input.expiresAt,
        sequence.toString(),
        traceId,
        acceptedAt,
      ],
    );
    await client.query(
      `INSERT INTO receipts (
         receipt_id, version, authority_epoch, canonical_payload, signature, relayer_authority
       ) VALUES ($1,1,$2,$3,$4,$5)`,
      [
        receiptId,
        input.authorityEpoch,
        Buffer.from(canonicalPayload),
        Buffer.from(receiptSignature),
        Buffer.from(input.relayerPublicKey),
      ],
    );
    await client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
       VALUES ('claim', $1, 'claim.accepted', $2::jsonb, $3)`,
      [
        receiptId,
        JSON.stringify({
          receiptId,
          campaign: input.campaign,
          round: input.round,
          wallet: input.wallet,
          sequence: sequence.toString(),
        }),
        traceId,
      ],
    );
    await client.query("COMMIT");
    return {
      receiptId,
      sequence,
      acceptedAt,
      status: "accepted",
      canonicalPayload,
      receiptSignature,
      duplicate: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Allocates and durably stores a bounded, arrival-ordered receipt micro-batch for one round.
 * Settlement remains one claim per Solana transaction; only the database acceptance critical
 * section is batched so the round sequence row is locked once instead of once per HTTP request.
 */
export async function acceptClaimBatch(
  pool: DatabasePool,
  inputs: readonly AcceptClaimInput[],
): Promise<BatchClaimAcceptance[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 500)
    throw new Error("claim acceptance batch exceeds 500 requests");
  const round = inputs[0]?.round;
  if (!round || inputs.some((input) => input.round !== round))
    throw new Error("claim acceptance batch must contain one round");
  const results: (BatchClaimAcceptance | undefined)[] = new Array(
    inputs.length,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO round_sequences(round) VALUES ($1) ON CONFLICT DO NOTHING",
      [round],
    );
    const counter = await client.query<{ next_sequence: string }>(
      "SELECT next_sequence FROM round_sequences WHERE round = $1 FOR UPDATE",
      [round],
    );
    const firstSequence = BigInt(counter.rows[0]?.next_sequence ?? "0");
    if (firstSequence < 1n) throw new Error("round sequence is unavailable");

    const wallets = [...new Set(inputs.map((input) => input.wallet))];
    const existing = await client.query<ExistingClaimRow & { wallet: string }>(
      `SELECT c.wallet, c.receipt_id, c.sequence, c.accepted_at, c.status,
              r.canonical_payload, r.signature AS receipt_signature
       FROM claim_requests c JOIN receipts r USING (receipt_id)
       WHERE c.round = $1 AND c.wallet = ANY($2::text[])`,
      [round, wallets],
    );
    const existingByWallet = new Map(
      existing.rows.map((row) => [row.wallet, row]),
    );
    const firstCandidateByWallet = new Map<string, number>();
    const duplicateOf = new Map<number, number>();
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      if (!input) continue;
      if (input.wallet !== input.recipient) {
        results[index] = {
          ok: false,
          error: new Error("recipient must equal wallet"),
        };
        continue;
      }
      if (input.expiresAt.getTime() <= Date.now()) {
        results[index] = {
          ok: false,
          error: new Error("claim intent expired"),
        };
        continue;
      }
      const prior = existingByWallet.get(input.wallet);
      if (prior) {
        results[index] = { ok: true, value: mapExisting(prior, true) };
        continue;
      }
      const first = firstCandidateByWallet.get(input.wallet);
      if (first !== undefined) duplicateOf.set(index, first);
      else firstCandidateByWallet.set(input.wallet, index);
    }
    const candidateIndices = [...firstCandidateByWallet.values()];
    if (candidateIndices.length > 0) {
      const sample = inputs[candidateIndices[0]!];
      const eligible = sample
        ? await client.query<{ eligible: boolean }>(
            `SELECT state = 'open' AND commitment IN ('confirmed', 'finalized')
                AND closes_at > clock_timestamp() AND winner_count < winner_cap AS eligible
         FROM round_projections WHERE round = $1 AND campaign = $2`,
            [round, sample.campaign],
          )
        : { rows: [] as { eligible: boolean }[] };
      if (!eligible.rows[0]?.eligible) {
        for (const index of candidateIndices)
          results[index] = {
            ok: false,
            error: new Error("round is not confirmed and open for claims"),
          };
      } else {
        const registrations = await client.query<{ wallet: string }>(
          `SELECT wallet FROM registration_projections
           WHERE campaign = $1 AND wallet = ANY($2::text[]) AND commitment IN ('confirmed', 'finalized')`,
          [
            sample?.campaign,
            candidateIndices.map((index) => inputs[index]?.wallet),
          ],
        );
        const registered = new Set(registrations.rows.map((row) => row.wallet));
        const challengeCandidates = candidateIndices.filter((index) => {
          const input = inputs[index];
          if (!input || !registered.has(input.wallet)) {
            results[index] = {
              ok: false,
              error: new Error("fan does not have a confirmed registration"),
            };
            return false;
          }
          return true;
        });
        const challengeRows = challengeCandidates.map((index) => {
          const input = inputs[index]!;
          return {
            wallet: input.wallet,
            nonceHash: Buffer.from(sha256(input.nonce)).toString("base64"),
            campaign: input.campaign,
            round: input.round,
            origin: input.origin,
          };
        });
        const consumed = challengeRows.length
          ? await client.query<{ wallet: string }>(
              `WITH requested AS (
             SELECT wallet, decode(nonce_hash, 'base64') AS nonce_hash, campaign, round, origin
             FROM jsonb_to_recordset($1::jsonb)
               AS item(wallet text, nonce_hash text, campaign text, round text, origin text)
           )
           UPDATE intent_challenges challenge SET used_at = clock_timestamp()
           FROM requested
           WHERE challenge.nonce_hash = requested.nonce_hash AND challenge.action = 'claim'
             AND challenge.wallet = requested.wallet AND challenge.campaign = requested.campaign
             AND challenge.round = requested.round AND challenge.origin = requested.origin
             AND challenge.used_at IS NULL AND challenge.expires_at >= clock_timestamp()
           RETURNING challenge.wallet`,
              [
                JSON.stringify(
                  challengeRows.map(({ nonceHash, ...row }) => ({
                    ...row,
                    nonce_hash: nonceHash,
                  })),
                ),
              ],
            )
          : { rows: [] as { wallet: string }[] };
        const consumedWallets = new Set(consumed.rows.map((row) => row.wallet));
        const acceptedIndices = challengeCandidates.filter((index) => {
          const input = inputs[index];
          if (!input || !consumedWallets.has(input.wallet)) {
            results[index] = {
              ok: false,
              error: new Error("claim challenge is invalid, used, or expired"),
            };
            return false;
          }
          return true;
        });
        if (acceptedIndices.length > 0) {
          const clock = await client.query<{
            accepted_at: Date;
            accepted_at_ms: string;
          }>(
            "SELECT clock_timestamp() AS accepted_at, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS accepted_at_ms",
          );
          const acceptedAt = clock.rows[0]?.accepted_at;
          const acceptedAtMs = clock.rows[0]?.accepted_at_ms;
          if (!acceptedAt || !acceptedAtMs)
            throw new Error("database clock unavailable");
          const claimRows: Record<string, unknown>[] = [];
          const receiptRows: Record<string, unknown>[] = [];
          const outboxRows: Record<string, unknown>[] = [];
          for (let offset = 0; offset < acceptedIndices.length; offset += 1) {
            const index = acceptedIndices[offset]!;
            const input = inputs[index]!;
            const sequence = firstSequence + BigInt(offset);
            const receiptId = randomUUID();
            const receipt: CanonicalReceipt = {
              version: 1,
              authorityEpoch: input.authorityEpoch,
              networkDomain: DEVNET_NETWORK_DOMAIN,
              programId: publicKeyBytes(input.programId),
              campaign: publicKeyBytes(input.campaign),
              round: publicKeyBytes(input.round),
              wallet: publicKeyBytes(input.wallet),
              intentHash: new Uint8Array(input.intentHash),
              sequence,
              acceptedAtMs: BigInt(acceptedAtMs),
              receiptId: uuidBytes(receiptId),
            };
            const canonicalPayload = encodeReceipt(receipt);
            const receiptSignature = signReceiptNative(
              receipt,
              input.relayerSecretKey,
            );
            const traceId = input.traceId ?? randomUUID();
            claimRows.push({
              receipt_id: receiptId,
              campaign: input.campaign,
              round: input.round,
              wallet: input.wallet,
              recipient: input.recipient,
              intent_hash: Buffer.from(input.intentHash).toString("base64"),
              fan_signature: Buffer.from(input.fanSignature).toString("base64"),
              nonce: Buffer.from(input.nonce).toString("base64"),
              expires_at: input.expiresAt.toISOString(),
              sequence: sequence.toString(),
              trace_id: traceId,
              accepted_at: acceptedAt.toISOString(),
            });
            receiptRows.push({
              receipt_id: receiptId,
              authority_epoch: input.authorityEpoch,
              canonical_payload:
                Buffer.from(canonicalPayload).toString("base64"),
              signature: Buffer.from(receiptSignature).toString("base64"),
              relayer_authority: Buffer.from(input.relayerPublicKey).toString(
                "base64",
              ),
            });
            outboxRows.push({
              aggregate_key: receiptId,
              trace_id: traceId,
              payload: {
                receiptId,
                campaign: input.campaign,
                round: input.round,
                wallet: input.wallet,
                sequence: sequence.toString(),
              },
            });
            results[index] = {
              ok: true,
              value: {
                receiptId,
                sequence,
                acceptedAt,
                status: "accepted",
                canonicalPayload,
                receiptSignature,
                duplicate: false,
              },
            };
          }
          await client.query(
            `INSERT INTO claim_requests (
               receipt_id, campaign, round, wallet, recipient, intent_hash, fan_signature,
               nonce, expires_at, sequence, status, trace_id, accepted_at
             ) SELECT receipt_id, campaign, round, wallet, recipient, decode(intent_hash,'base64'),
                      decode(fan_signature,'base64'), decode(nonce,'base64'), expires_at,
                      sequence, 'accepted', trace_id, accepted_at
             FROM jsonb_to_recordset($1::jsonb) AS item(
               receipt_id uuid, campaign text, round text, wallet text, recipient text,
               intent_hash text, fan_signature text, nonce text, expires_at timestamptz,
               sequence bigint, trace_id uuid, accepted_at timestamptz
             )`,
            [JSON.stringify(claimRows)],
          );
          await client.query(
            `INSERT INTO receipts (receipt_id, version, authority_epoch, canonical_payload, signature, relayer_authority)
             SELECT receipt_id, 1, authority_epoch, decode(canonical_payload,'base64'),
                    decode(signature,'base64'), decode(relayer_authority,'base64')
             FROM jsonb_to_recordset($1::jsonb) AS item(
               receipt_id uuid, authority_epoch integer, canonical_payload text, signature text, relayer_authority text
             )`,
            [JSON.stringify(receiptRows)],
          );
          await client.query(
            `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
             SELECT 'claim', aggregate_key, 'claim.accepted', payload, trace_id
             FROM jsonb_to_recordset($1::jsonb) AS item(aggregate_key text, payload jsonb, trace_id uuid)`,
            [JSON.stringify(outboxRows)],
          );
          await client.query(
            `UPDATE round_sequences SET next_sequence = next_sequence + $2, updated_at = clock_timestamp() WHERE round = $1`,
            [round, acceptedIndices.length],
          );
        }
      }
    }
    await client.query("COMMIT");
    for (const [index, firstIndex] of duplicateOf) {
      const first = results[firstIndex];
      results[index] = first?.ok
        ? { ok: true, value: { ...first.value, duplicate: true } }
        : (first ?? {
            ok: false,
            error: new Error("duplicate claim could not be resolved"),
          });
    }
    return results.map(
      (result) =>
        result ?? {
          ok: false,
          error: new Error("claim acceptance was not resolved"),
        },
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

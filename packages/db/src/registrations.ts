import { randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DatabasePool } from "./pool.js";

export interface AcceptRegistrationInput {
  campaign: string;
  wallet: string;
  intentHash: Uint8Array;
  fanSignature: Uint8Array;
  nonce: Uint8Array;
  expiresAt: Date;
  origin: string;
  traceId?: string;
}

export interface AcceptedRegistration {
  id: string;
  campaign: string;
  wallet: string;
  status:
    "accepted" | "submitted" | "confirmed" | "finalized" | "expired" | "failed";
  acceptedAt: Date;
  duplicate: boolean;
}

export async function registrationRequestExists(
  pool: DatabasePool,
  campaign: string,
  wallet: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM registration_requests WHERE campaign = $1 AND wallet = $2",
    [campaign, wallet],
  );
  return result.rowCount === 1;
}

export async function acceptRegistration(
  pool: DatabasePool,
  input: AcceptRegistrationInput,
): Promise<AcceptedRegistration> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT campaign FROM campaign_projections WHERE campaign = $1 FOR UPDATE",
      [input.campaign],
    );
    const existing = await client.query<{
      id: string;
      campaign: string;
      wallet: string;
      status: AcceptedRegistration["status"];
      accepted_at: Date;
    }>(
      "SELECT id, campaign, wallet, status, accepted_at FROM registration_requests WHERE campaign = $1 AND wallet = $2",
      [input.campaign, input.wallet],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      const row = existing.rows[0];
      return {
        id: row.id,
        campaign: row.campaign,
        wallet: row.wallet,
        status: row.status,
        acceptedAt: row.accepted_at,
        duplicate: true,
      };
    }
    const eligible = await client.query<{ eligible: boolean }>(
      `SELECT state = 'active' AND terminal_reason = 'none'
              AND registration_deadline >= clock_timestamp() AND hard_expiry > clock_timestamp() AS eligible
       FROM campaign_projections WHERE campaign = $1`,
      [input.campaign],
    );
    requireRow(
      eligible.rows[0]?.eligible,
      "campaign is not open for registration",
    );
    const challenge = await client.query(
      `UPDATE intent_challenges SET used_at = clock_timestamp()
       WHERE nonce_hash = $1 AND action = 'register' AND wallet = $2 AND campaign = $3
         AND round IS NULL AND origin = $4 AND used_at IS NULL AND expires_at >= clock_timestamp()
       RETURNING nonce_hash`,
      [
        Buffer.from(sha256(input.nonce)),
        input.wallet,
        input.campaign,
        input.origin,
      ],
    );
    requireRow(
      challenge.rowCount === 1,
      "registration challenge is invalid, used, or expired",
    );
    const id = randomUUID();
    const traceId = input.traceId ?? randomUUID();
    const inserted = await client.query<{ accepted_at: Date }>(
      `INSERT INTO registration_requests (
         id, campaign, wallet, intent_hash, fan_signature, nonce, expires_at, status, trace_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8) RETURNING accepted_at`,
      [
        id,
        input.campaign,
        input.wallet,
        Buffer.from(input.intentHash),
        Buffer.from(input.fanSignature),
        Buffer.from(input.nonce),
        input.expiresAt,
        traceId,
      ],
    );
    await client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
       VALUES ('registration', $1, 'registration.accepted', $2::jsonb, $3)`,
      [
        id,
        JSON.stringify({
          registrationId: id,
          campaign: input.campaign,
          wallet: input.wallet,
        }),
        traceId,
      ],
    );
    await client.query("COMMIT");
    return {
      id,
      campaign: input.campaign,
      wallet: input.wallet,
      status: "accepted",
      acceptedAt: inserted.rows[0]?.accepted_at ?? new Date(),
      duplicate: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requireRow(
  condition: boolean | undefined,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

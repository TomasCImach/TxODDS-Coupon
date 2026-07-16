import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import type { DatabasePool } from "./pool.js";

export type ChallengeAction = "register" | "claim";

export interface IssueChallengeInput {
  action: ChallengeAction;
  wallet: string;
  campaign: string;
  round?: string;
  origin: string;
  ttlSeconds?: number;
}

export async function issueChallenge(
  pool: DatabasePool,
  input: IssueChallengeInput,
): Promise<{ nonce: Uint8Array; expiresAt: Date }> {
  if ((input.action === "register") !== (input.round === undefined)) {
    throw new Error(
      "registration challenges omit round; claim challenges require round",
    );
  }
  const nonce = randomBytes(16);
  const nonceHash = sha256(nonce);
  const ttlSeconds = Math.min(Math.max(input.ttlSeconds ?? 60, 15), 120);
  const result = await pool.query<{ expires_at: Date }>(
    `INSERT INTO intent_challenges (nonce_hash, action, wallet, campaign, round, origin, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() + make_interval(secs => $7))
     ON CONFLICT (action, wallet, campaign, (COALESCE(round, ''))) WHERE used_at IS NULL
     DO UPDATE SET nonce_hash = EXCLUDED.nonce_hash, origin = EXCLUDED.origin,
                   expires_at = EXCLUDED.expires_at, created_at = clock_timestamp()
     RETURNING expires_at`,
    [
      Buffer.from(nonceHash),
      input.action,
      input.wallet,
      input.campaign,
      input.round ?? null,
      input.origin,
      ttlSeconds,
    ],
  );
  const expiresAt = result.rows[0]?.expires_at;
  if (!expiresAt) throw new Error("challenge issuance failed");
  return { nonce: new Uint8Array(nonce), expiresAt };
}

export async function consumeChallenge(
  pool: DatabasePool,
  nonce: Uint8Array,
  scope: Omit<IssueChallengeInput, "ttlSeconds">,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE intent_challenges SET used_at = clock_timestamp()
     WHERE nonce_hash = $1 AND action = $2 AND wallet = $3 AND campaign = $4
       AND round IS NOT DISTINCT FROM $5 AND origin = $6 AND used_at IS NULL
       AND expires_at >= clock_timestamp()
     RETURNING nonce_hash`,
    [
      Buffer.from(sha256(nonce)),
      scope.action,
      scope.wallet,
      scope.campaign,
      scope.round ?? null,
      scope.origin,
    ],
  );
  return result.rowCount === 1;
}

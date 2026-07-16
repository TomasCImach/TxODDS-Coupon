import bs58 from "bs58";
import nacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IntentAction,
  canonicalizeIntent,
  intentHash,
} from "@goaldrop/protocol";
import { acceptClaim } from "./sequencer.js";
import { issueChallenge } from "./challenges.js";
import {
  claimOutboxBatch,
  deferOutbox,
  markOutboxPublished,
} from "./outbox.js";
import { createPool, type DatabasePool } from "./pool.js";

const connectionString = process.env.TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
const programId = "AKrUp5CXKrHHVUiKqVBv9vcRzNDPbmRvKFCwEyZqvcqp";
const origin = "http://localhost:3000";

integration("PostgreSQL durable sequencer", () => {
  let pool: DatabasePool;
  const sponsor = address(1);
  const campaign = address(2);
  const round = address(3);
  const mint = address(4);
  const relayer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(77));

  beforeAll(async () => {
    pool = createPool(connectionString);
    await pool.query(`TRUNCATE TABLE
      receipts, claim_requests, round_sequences, intent_challenges, registration_projections,
      round_projections, campaign_projections, outbox, application_events RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO campaign_projections (
         campaign, fixture_id, sponsor, state, reward_mint, refund_wallet, scheduled_start,
         registration_deadline, expected_end, hard_expiry, required_funding, funded_amount,
         last_slot, commitment
       ) VALUES ($1,42,$2,'active',$3,$2,clock_timestamp() + interval '1 hour',
                 clock_timestamp() + interval '30 minutes',clock_timestamp() + interval '3 hours',
                 clock_timestamp() + interval '8 hours',100000,100000,1,'confirmed')`,
      [campaign, sponsor, mint],
    );
    await pool.query(
      `INSERT INTO round_projections (
         round, campaign, ordinal, source, event_key, opened_at, closes_at, reward_amount,
         winner_cap, state, last_slot, commitment
       ) VALUES ($1,$2,0,'demo',$3,clock_timestamp(),clock_timestamp() + interval '10 minutes',
                 1000,100,'open',2,'confirmed')`,
      [round, campaign, Buffer.alloc(32, 9)],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns one committed receipt for concurrent duplicate wallet submissions", async () => {
    const fan = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
    const wallet = bs58.encode(fan.publicKey);
    await seedRegistration(pool, campaign, wallet, 10);
    const input = await claimInput(pool, { campaign, round, fan, relayer });
    const results = await Promise.all(
      Array.from({ length: 25 }, () => acceptClaim(pool, input)),
    );
    expect(new Set(results.map((result) => result.receiptId)).size).toBe(1);
    expect(new Set(results.map((result) => result.sequence))).toEqual(
      new Set([1n]),
    );
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    const stored = await pool.query(
      "SELECT c.sequence, r.canonical_payload FROM claim_requests c JOIN receipts r USING (receipt_id)",
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.sequence).toBe("1");
  });

  it("assigns unique contiguous sequences under a multi-wallet burst", async () => {
    const inputs = [];
    for (let index = 0; index < 40; index += 1) {
      const fan = nacl.sign.keyPair.fromSeed(
        new Uint8Array(32).fill(index + 20),
      );
      await seedRegistration(
        pool,
        campaign,
        bs58.encode(fan.publicKey),
        index + 20,
      );
      inputs.push(await claimInput(pool, { campaign, round, fan, relayer }));
    }
    const results = await Promise.all(
      inputs.map((input) => acceptClaim(pool, input)),
    );
    const sequences = results
      .map((result) => Number(result.sequence))
      .sort((left, right) => left - right);
    expect(sequences).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 2),
    );
    expect(new Set(results.map((result) => result.receiptId)).size).toBe(40);
    const counter = await pool.query<{ next_sequence: string }>(
      "SELECT next_sequence FROM round_sequences WHERE round = $1",
      [round],
    );
    expect(counter.rows[0]?.next_sequence).toBe("42");
  });

  it("rolls back sequence allocation when the one-time challenge is invalid", async () => {
    const fan = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(75));
    const wallet = bs58.encode(fan.publicKey);
    await seedRegistration(pool, campaign, wallet, 75);
    const valid = await claimInput(pool, { campaign, round, fan, relayer });
    await expect(
      acceptClaim(pool, { ...valid, nonce: new Uint8Array(16).fill(255) }),
    ).rejects.toThrow(/challenge/);
    const counter = await pool.query<{ next_sequence: string }>(
      "SELECT next_sequence FROM round_sequences WHERE round = $1",
      [round],
    );
    expect(counter.rows[0]?.next_sequence).toBe("42");
  });

  it("leases outbox work once across workers and recovers it after a crash", async () => {
    await pool.query("UPDATE outbox SET published_at = clock_timestamp()");
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
       VALUES ('claim','lease-test','claim.accepted','{}',gen_random_uuid()) RETURNING id`,
    );
    const id = BigInt(inserted.rows[0]?.id ?? "0");
    const [firstWorker, secondWorker] = await Promise.all([
      claimOutboxBatch(pool, ["claim.accepted"], 1),
      claimOutboxBatch(pool, ["claim.accepted"], 1),
    ]);
    expect(
      [...firstWorker, ...secondWorker].map((message) => message.id),
    ).toEqual([id]);
    expect(await claimOutboxBatch(pool, ["claim.accepted"], 1)).toEqual([]);

    await pool.query(
      "UPDATE outbox SET available_at = clock_timestamp() WHERE id = $1",
      [id.toString()],
    );
    const recovered = await claimOutboxBatch(pool, ["claim.accepted"], 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id, attempts: 2 });
    await markOutboxPublished(pool, id);
    expect(await claimOutboxBatch(pool, ["claim.accepted"], 1)).toEqual([]);
  });

  it("dead-letters a command after twelve failed leases", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id, attempts)
       VALUES ('test','dead-letter-test','claim.accepted','{}',gen_random_uuid(),12) RETURNING id`,
    );
    const id = BigInt(inserted.rows[0]?.id ?? "0");
    await deferOutbox(pool, id, "permanent test failure");
    const state = await pool.query<{ dead_lettered_at: Date | null }>(
      "SELECT dead_lettered_at FROM outbox WHERE id = $1",
      [id.toString()],
    );
    expect(state.rows[0]?.dead_lettered_at).toBeInstanceOf(Date);
    expect(await claimOutboxBatch(pool, ["claim.accepted"], 10)).toEqual([]);
  });
});

async function claimInput(
  pool: DatabasePool,
  keys: {
    campaign: string;
    round: string;
    fan: nacl.SignKeyPair;
    relayer: nacl.SignKeyPair;
  },
) {
  const wallet = bs58.encode(keys.fan.publicKey);
  const challenge = await issueChallenge(pool, {
    action: "claim",
    campaign: keys.campaign,
    round: keys.round,
    wallet,
    origin,
  });
  const expiresAtSeconds = BigInt(
    Math.floor(challenge.expiresAt.getTime() / 1_000),
  );
  const fields = canonicalizeIntent({
    programId,
    action: IntentAction.Claim,
    campaign: keys.campaign,
    round: keys.round,
    wallet,
    nonce: challenge.nonce,
    expiresAt: expiresAtSeconds,
  });
  const hash = intentHash(fields);
  return {
    campaign: keys.campaign,
    round: keys.round,
    wallet,
    recipient: wallet,
    programId,
    intentHash: hash,
    fanSignature: nacl.sign.detached(hash, keys.fan.secretKey),
    nonce: challenge.nonce,
    expiresAt: new Date(Number(expiresAtSeconds) * 1_000),
    origin,
    authorityEpoch: 0,
    relayerPublicKey: keys.relayer.publicKey,
    relayerSecretKey: keys.relayer.secretKey,
  };
}

async function seedRegistration(
  pool: DatabasePool,
  campaign: string,
  wallet: string,
  slot: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO registration_projections (
       campaign, wallet, registration_pda, confirmed_slot, transaction_signature, commitment, registered_at
     ) VALUES ($1,$2,$3,$4,$5,'confirmed',clock_timestamp())`,
    [campaign, wallet, address(slot + 100), slot, `synthetic-${slot}`],
  );
}

function address(seed: number): string {
  return bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed)).publicKey,
  );
}

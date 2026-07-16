import bs58 from "bs58";
import { createPool, type DatabasePool } from "@goaldrop/db";
import {
  IntentAction,
  canonicalizeIntent,
  intentHash,
} from "@goaldrop/protocol";
import { PublicKey } from "@solana/web3.js";
import { parseTxlineRecord } from "@goaldrop/txline-adapter";
import nacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import { runApiMaintenance } from "./maintenance.js";
import {
  ingestTxlineRecord,
  purgeExpiredRawPayloads,
} from "./workers/txline.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("GoalDrop HTTP contracts", () => {
  let pool: DatabasePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let config: ServiceConfig;
  const programId = address(1);
  const campaign = address(2);
  const round = address(3);
  const mint = address(4);
  const sponsor = address(5);
  const relayer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
  const fan = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const wallet = bs58.encode(fan.publicKey);

  beforeAll(async () => {
    config = loadConfig("api", {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "4000",
      LOG_LEVEL: "silent",
      PUBLIC_ORIGIN: "http://localhost:3000",
      DATABASE_URL: databaseUrl,
      SOLANA_CLUSTER: "devnet",
      SOLANA_HTTP_RPC_URL: "https://api.devnet.solana.com",
      SOLANA_WS_RPC_URL: "wss://api.devnet.solana.com",
      GOALDROP_PROGRAM_ID: programId,
      GOALDROP_REWARD_MINT: mint,
      TXLINE_API_ORIGIN: "https://txline-dev.txodds.com",
      TXLINE_PROGRAM_ID: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
      TXLINE_TXL_MINT: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
      TXLINE_SERVICE_LEVEL: "1",
      ROUND_DURATION_SECONDS: "120",
      LIVE_EVENT_MAX_LATENESS_SECONDS: "60",
      DEFAULT_HARD_EXPIRY_SECONDS: "28800",
      TXLINE_PUBLIC_OUTPUT_ENABLED: "false",
      TXLINE_RAW_RETENTION_ENABLED: "false",
      DEMO_MODE_ENABLED: "false",
      RELAYER_KEYPAIR: Buffer.from(relayer.secretKey).toString("base64"),
      RECEIPT_CAPABILITY_KEY: Buffer.from(nacl.randomBytes(32)).toString(
        "base64",
      ),
      FEE_PAYER_KEYPAIR: Buffer.from(relayer.secretKey).toString("base64"),
    });
    pool = createPool(databaseUrl);
    await pool.query(`TRUNCATE TABLE
      analytics_events, demo_faucet_claims, sponsored_transaction_templates, receipts, claim_requests, registration_requests, round_sequences, intent_challenges,
      registration_projections, round_projections, campaign_projections, fixture_catalog,
      txline_events, txline_cursors, goal_decisions, audit_log,
      outbox, application_events RESTART IDENTITY CASCADE`);
    await pool.query(
      `INSERT INTO campaign_projections (
         campaign, fixture_id, sponsor, state, reward_mint, refund_wallet, scheduled_start,
         registration_deadline, expected_end, hard_expiry, required_funding, funded_amount, last_slot, commitment
       ) VALUES ($1,99,$2,'active',$3,$2,clock_timestamp() + interval '1 hour',clock_timestamp() + interval '30 minutes',
                 clock_timestamp() + interval '3 hours',clock_timestamp() + interval '8 hours',100000,100000,1,'confirmed')`,
      [campaign, sponsor, mint],
    );
    await pool.query(
      `INSERT INTO round_projections (
         round, campaign, ordinal, source, event_key, opened_at, closes_at, reward_amount,
         winner_cap, state, last_slot, commitment
       ) VALUES ($1,$2,0,'demo',$3,clock_timestamp(),clock_timestamp() + interval '10 minutes',1000,100,'open',2,'confirmed')`,
      [round, campaign, Buffer.alloc(32, 4)],
    );
    app = await createApp({
      config,
      pool,
      onchain: {
        address: new PublicKey(address(8)),
        authorityEpoch: 3,
        admin: new PublicKey(address(9)),
        oracle: new PublicKey(address(10)),
        relayer: new PublicKey(relayer.publicKey),
        demoAuthority: new PublicKey(address(11)),
        rewardMint: new PublicKey(mint),
        rewardDecimals: 6,
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("issues and durably accepts a signed registration intent", async () => {
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/intents/registration",
      headers: { origin: "http://localhost:3000" },
      payload: { campaign, wallet },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challenge = challengeResponse.json<{
      nonce: string;
      expiresAt: number;
      intentHash: string;
    }>();
    const fields = canonicalizeIntent({
      programId,
      action: IntentAction.Register,
      campaign,
      wallet,
      nonce: Buffer.from(challenge.nonce, "base64url"),
      expiresAt: BigInt(challenge.expiresAt),
    });
    const hash = intentHash(fields);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/registrations",
      headers: { origin: "http://localhost:3000" },
      payload: {
        campaign,
        wallet,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: Buffer.from(hash).toString("hex"),
        signature: Buffer.from(
          nacl.sign.detached(hash, fan.secretKey),
        ).toString("base64"),
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      campaign,
      wallet,
      status: "accepted",
      duplicate: false,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/registrations",
      headers: { origin: "http://localhost:3000" },
      payload: {
        campaign,
        wallet,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: Buffer.from(hash).toString("hex"),
        signature: Buffer.from(
          nacl.sign.detached(hash, fan.secretKey),
        ).toString("base64"),
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true });
  });

  it("accepts a claim, returns a signed receipt capability, and authorizes its read", async () => {
    await pool.query(
      `INSERT INTO registration_projections (
         campaign, wallet, registration_pda, confirmed_slot, transaction_signature, commitment, registered_at
       ) VALUES ($1,$2,$3,3,'synthetic','confirmed',clock_timestamp())`,
      [campaign, wallet, address(12)],
    );
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/intents/claim",
      headers: { origin: "http://localhost:3000" },
      payload: { campaign, round, wallet },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challenge = challengeResponse.json<{
      nonce: string;
      expiresAt: number;
    }>();
    const fields = canonicalizeIntent({
      programId,
      action: IntentAction.Claim,
      campaign,
      round,
      wallet,
      nonce: Buffer.from(challenge.nonce, "base64url"),
      expiresAt: BigInt(challenge.expiresAt),
    });
    const hash = intentHash(fields);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/claims",
      headers: { origin: "http://localhost:3000" },
      payload: {
        campaign,
        round,
        wallet,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: Buffer.from(hash).toString("hex"),
        signature: Buffer.from(
          nacl.sign.detached(hash, fan.secretKey),
        ).toString("base64"),
      },
    });
    expect(accepted.statusCode).toBe(200);
    const receipt = accepted.json<{
      receiptId: string;
      capability: string;
      status: string;
    }>();
    expect(receipt.status).toBe("accepted");
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/claims",
      headers: { origin: "http://localhost:3000" },
      payload: {
        campaign,
        round,
        wallet,
        nonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
        intentHash: Buffer.from(hash).toString("hex"),
        signature: Buffer.from(
          nacl.sign.detached(hash, fan.secretKey),
        ).toString("base64"),
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      receiptId: receipt.receiptId,
      sequence: "1",
      duplicate: true,
    });
    const read = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receipt.receiptId}?cap=${encodeURIComponent(receipt.capability)}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      receiptId: receipt.receiptId,
      status: "accepted",
      sequence: "1",
    });
  });

  it("rejects state-changing requests from an unapproved origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/intents/registration",
      headers: { origin: "https://evil.example" },
      payload: { campaign, wallet },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "request_rejected" });
  });

  it("exports operational backlog and retention gauges", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/internal/metrics",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("goaldrop_pending_claims");
    expect(response.body).toContain("goaldrop_overdue_raw_payloads");
    expect(response.body).toContain("goaldrop_fee_payer_lamports");
    expect(response.body).toContain("goaldrop_sponsored_admission_open");
    expect(response.body).toContain("goaldrop_campaigns");
    expect(response.body).toContain("goaldrop_rounds");
    expect(response.body).toContain("goaldrop_claim_receipts");
    expect(response.body).toContain("goaldrop_txline_decisions");
    expect(response.body).toContain("goaldrop_registrations");
    expect(response.body).toContain("goaldrop_winners");
    expect(response.body).toContain("goaldrop_paid_base_units");
    expect(response.body).toContain("goaldrop_refundable_residual_base_units");
    expect(response.body).toContain("goaldrop_oldest_outbox_age_seconds");
    expect(response.body).toContain("goaldrop_txline_heartbeat_age_seconds");
    expect(response.body).toContain("goaldrop_database_pool_connections");
  });

  it("accepts allowlisted cookieless analytics and rejects wallet data", async () => {
    const valid = await app.inject({
      method: "POST",
      url: "/v1/analytics/events",
      headers: { origin: "http://localhost:3000" },
      payload: {
        sessionId: crypto.randomUUID(),
        events: [
          {
            eventId: crypto.randomUUID(),
            eventName: "claim_started",
            campaign,
            occurredAt: new Date().toISOString(),
            properties: { round_source: "demo", round_ordinal: 0 },
          },
        ],
      },
    });
    expect(valid.statusCode).toBe(202);
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/analytics/events",
      headers: { origin: "http://localhost:3000" },
      payload: {
        sessionId: crypto.randomUUID(),
        events: [
          {
            eventId: crypto.randomUUID(),
            eventName: "claim_started",
            campaign,
            occurredAt: new Date().toISOString(),
            properties: { wallet_address: wallet },
          },
        ],
      },
    });
    expect(forbidden.statusCode).toBe(400);
  });

  it("enforces analytics and encrypted raw-payload retention", async () => {
    const analyticsId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO analytics_events (event_id, session_id, event_name, properties, occurred_at, collected_at)
       VALUES ($1,$2,'campaign_viewed','{}',clock_timestamp() - interval '31 days',clock_timestamp() - interval '31 days')`,
      [analyticsId, crypto.randomUUID()],
    );
    await pool.query(
      `INSERT INTO txline_events (
         fixture_id, seq, action, adapter_version, normalized, raw_digest,
         encrypted_raw_payload, raw_delete_after, decision
       ) VALUES (909090,1,'heartbeat','test','{}',$1,$2,clock_timestamp() - interval '1 minute','ignored')
       ON CONFLICT (fixture_id, seq) DO UPDATE SET encrypted_raw_payload = EXCLUDED.encrypted_raw_payload,
         raw_delete_after = EXCLUDED.raw_delete_after`,
      [Buffer.alloc(32, 1), Buffer.from("encrypted")],
    );

    const maintenance = await runApiMaintenance(pool);
    expect(maintenance.analyticsDeleted).toBeGreaterThanOrEqual(1);
    expect(await purgeExpiredRawPayloads(pool)).toBe(1);
    const retained = await pool.query<{ encrypted_raw_payload: Buffer | null }>(
      "SELECT encrypted_raw_payload FROM txline_events WHERE fixture_id = 909090 AND seq = 1",
    );
    expect(retained.rows[0]?.encrypted_raw_payload).toBeNull();
  });

  it("persists provider discards as immutable audit corrections", async () => {
    const raw = new TextEncoder().encode("discarded-goal-7001");
    const result = await ingestTxlineRecord(
      config,
      pool,
      parseTxlineRecord({
        action: "action_discarded",
        fixtureId: "909091",
        id: "8001",
        originalActionId: "7001",
        seq: 44,
        ts: "1900000000000",
      }),
      raw,
      "discard-44",
    );

    expect(result).toBe("inserted");
    const event = await pool.query<{ decision: string }>(
      "SELECT decision FROM txline_events WHERE fixture_id = 909091 AND seq = 44",
    );
    expect(event.rows[0]?.decision).toBe("discarded");
    const audit = await pool.query<{ action: string; target_key: string }>(
      "SELECT action, target_key FROM audit_log WHERE actor_type = 'txline' AND actor_key = '909091' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]).toEqual({ action: "discard", target_key: "7001" });
  });
});

function address(seed: number): string {
  return bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed)).publicKey,
  );
}

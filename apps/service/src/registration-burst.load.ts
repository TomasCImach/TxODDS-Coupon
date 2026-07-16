import bs58 from "bs58";
import { createPool, migrate } from "@goaldrop/db";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const programId = address(1);
const campaign = address(2);
const mint = address(4);
const sponsor = address(5);
const relayer = nacl.sign.keyPair.fromSeed(seed(6));
const config = loadConfig("api", {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "4000",
  LOG_LEVEL: "silent",
  PUBLIC_ORIGIN: "http://localhost:3000",
  DATABASE_URL: databaseUrl,
  DATABASE_POOL_SIZE: "50",
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
  RECEIPT_CAPABILITY_KEY: Buffer.from(nacl.randomBytes(32)).toString("base64"),
  FEE_PAYER_KEYPAIR: Buffer.from(relayer.secretKey).toString("base64"),
});

const pool = createPool(databaseUrl);
await migrate(pool);
await pool.query(`TRUNCATE TABLE
  analytics_events, sponsored_transaction_templates, receipts, claim_requests, registration_requests,
  round_sequences, intent_challenges, registration_projections, round_projections,
  campaign_round_configs, campaign_projections, fixture_catalog, outbox, application_events
  RESTART IDENTITY CASCADE`);
await pool.query(
  `INSERT INTO campaign_projections (
     campaign, fixture_id, sponsor, state, reward_mint, refund_wallet, scheduled_start,
     registration_deadline, expected_end, hard_expiry, required_funding, funded_amount, last_slot, commitment
   ) VALUES ($1,908,$2,'active',$3,$2,clock_timestamp() + interval '1 hour',clock_timestamp() + interval '30 minutes',
             clock_timestamp() + interval '3 hours',clock_timestamp() + interval '8 hours',1000000,1000000,1,'confirmed')`,
  [campaign, sponsor, mint],
);

const app = await createApp({
  config,
  pool,
  onchain: {
    address: new PublicKey(address(8)),
    authorityEpoch: 1,
    admin: new PublicKey(address(9)),
    oracle: new PublicKey(address(10)),
    relayer: new PublicKey(relayer.publicKey),
    demoAuthority: new PublicKey(address(11)),
    rewardMint: new PublicKey(mint),
    rewardDecimals: 6,
  },
});
await app.ready();

try {
  const fans = Array.from({ length: 1_000 }, (_, index) =>
    nacl.sign.keyPair.fromSeed(seed(index + 10_000)),
  );
  const challenges = await Promise.all(
    fans.map(async (fan, index) => {
      const wallet = bs58.encode(fan.publicKey);
      const response = await app.inject({
        method: "POST",
        url: "/v1/intents/registration",
        remoteAddress: ip(index),
        headers: { origin: "http://localhost:3000" },
        payload: { campaign, wallet },
      });
      if (response.statusCode !== 200)
        throw new Error(`challenge ${index} failed: ${response.body}`);
      return {
        fan,
        wallet,
        challenge: response.json<{
          nonce: string;
          expiresAt: number;
          intentHash: string;
        }>(),
      };
    }),
  );

  const started = process.hrtime.bigint();
  const responses = await Promise.all(
    challenges.map(async ({ fan, wallet, challenge }, index) => {
      const requestStarted = process.hrtime.bigint();
      const response = await app.inject({
        method: "POST",
        url: "/v1/registrations",
        remoteAddress: ip(index),
        headers: { origin: "http://localhost:3000" },
        payload: {
          campaign,
          wallet,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          intentHash: challenge.intentHash,
          signature: Buffer.from(
            nacl.sign.detached(
              Buffer.from(challenge.intentHash, "hex"),
              fan.secretKey,
            ),
          ).toString("base64"),
        },
      });
      return {
        response,
        latencyMs: Number(process.hrtime.bigint() - requestStarted) / 1_000_000,
      };
    }),
  );
  const wallMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const failures = responses.filter(
    ({ response }) => response.statusCode !== 200,
  );
  if (failures.length)
    throw new Error(
      `${failures.length} registration acknowledgements failed: ${failures[0]?.response.body}`,
    );
  const count = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM registration_requests WHERE campaign = $1",
    [campaign],
  );
  if (count.rows[0]?.count !== "1000")
    throw new Error(
      `expected 1000 durable registrations, found ${count.rows[0]?.count ?? "0"}`,
    );
  const latencies = responses
    .map(({ latencyMs }) => latencyMs)
    .sort((left, right) => left - right);
  process.stdout.write(
    `${JSON.stringify({
      registrations: 1_000,
      wallMs: Math.round(wallMs),
      p50Ms: Math.round(latencies[499] ?? 0),
      p95Ms: Math.round(latencies[949] ?? 0),
      durableRows: Number(count.rows[0].count),
    })}\n`,
  );
} finally {
  await app.close();
  await pool.end();
}

function seed(value: number): Uint8Array {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function address(value: number): string {
  return bs58.encode(nacl.sign.keyPair.fromSeed(seed(value)).publicKey);
}

function ip(index: number): string {
  return `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;
}

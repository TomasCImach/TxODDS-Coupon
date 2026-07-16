import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import {
  createTxlineSseParser,
  decideRecord,
  parseTxlineRecord,
  type TxlineRecord,
} from "@goaldrop/txline-adapter";
import type { DatabasePool } from "@goaldrop/db";
import type { ServiceConfig } from "../config.js";

interface Credentials {
  guestJwt: string;
  apiToken: string;
}
interface ListenerLogger {
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

export async function runTxlineSupervisor(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: ListenerLogger,
  signal: AbortSignal,
): Promise<void> {
  const credentials: Credentials = {
    guestJwt: config.TXLINE_GUEST_JWT ?? "",
    apiToken: config.TXLINE_API_TOKEN ?? "",
  };
  const active = new Map<string, AbortController>();
  let nextFixtureSyncAt = 0;
  let nextRawPurgeAt = 0;
  while (!signal.aborted) {
    if (Date.now() >= nextRawPurgeAt) {
      try {
        const purged = await purgeExpiredRawPayloads(pool);
        if (purged > 0)
          logger.info({ purged }, "expired encrypted TxLINE payloads deleted");
      } catch (error) {
        logger.error(
          { error: safeMessage(error) },
          "TxLINE raw-payload deletion job failed",
        );
      }
      nextRawPurgeAt = Date.now() + 60_000;
    }
    if (Date.now() >= nextFixtureSyncAt) {
      try {
        await syncFixtureCatalog(config, pool, credentials, signal);
      } catch (error) {
        logger.warn(
          { error: safeMessage(error) },
          "TxLINE fixture snapshot refresh failed",
        );
      }
      nextFixtureSyncAt = Date.now() + 60_000;
    }
    const campaigns = await pool.query<{
      fixture_id: string;
      campaign: string;
    }>(
      "SELECT fixture_id::text, campaign FROM campaign_projections WHERE state = 'active' AND terminal_reason = 'none' AND hard_expiry > clock_timestamp()",
    );
    const desired = new Set(campaigns.rows.map((row) => row.fixture_id));
    for (const [fixture, controller] of active) {
      if (!desired.has(fixture)) {
        controller.abort();
        active.delete(fixture);
      }
    }
    for (const row of campaigns.rows) {
      if (active.has(row.fixture_id)) continue;
      const controller = new AbortController();
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
      active.set(row.fixture_id, controller);
      void consumeFixture(
        config,
        pool,
        logger,
        credentials,
        BigInt(row.fixture_id),
        controller.signal,
      )
        .catch((error: unknown) =>
          logger.error(
            { fixtureId: row.fixture_id, error: safeMessage(error) },
            "TxLINE fixture listener stopped",
          ),
        )
        .finally(() => active.delete(row.fixture_id));
    }
    await delay(15_000, signal);
  }
  for (const controller of active.values()) controller.abort();
}

export async function purgeExpiredRawPayloads(
  pool: DatabasePool,
): Promise<number> {
  const result = await pool.query(
    `UPDATE txline_events
       SET encrypted_raw_payload = NULL, raw_delete_after = NULL
     WHERE encrypted_raw_payload IS NOT NULL AND raw_delete_after <= clock_timestamp()`,
  );
  return result.rowCount ?? 0;
}

const fixtureSnapshot = z.array(
  z.object({
    FixtureId: z.union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/),
    ]),
    StartTime: z.union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/),
    ]),
    Competition: z.string().min(1).max(100),
    CompetitionId: z.number().int(),
    Participant1: z.string().min(1).max(100),
    Participant2: z.string().min(1).max(100),
    Participant1IsHome: z.boolean(),
  }),
);

async function syncFixtureCatalog(
  config: ServiceConfig,
  pool: DatabasePool,
  credentials: Credentials,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL("/api/fixtures/snapshot", config.TXLINE_API_ORIGIN);
  url.searchParams.set(
    "startEpochDay",
    String(Math.floor(Date.now() / 86_400_000)),
  );
  let response = await authenticatedFetch(url, credentials, undefined, signal);
  if (response.status === 401) {
    credentials.guestJwt = await renewGuestJwt(config, signal);
    response = await authenticatedFetch(url, credentials, undefined, signal);
  }
  if (response.status === 403)
    throw new TxlineEntitlementError("TxLINE fixture snapshot returned 403");
  if (!response.ok)
    throw new Error(`TxLINE fixture snapshot returned ${response.status}`);
  const fixtures = fixtureSnapshot.parse(await response.json());
  for (const fixture of fixtures) {
    const start = BigInt(fixture.StartTime);
    const startMilliseconds = start > 10_000_000_000n ? start : start * 1_000n;
    const home = fixture.Participant1IsHome
      ? fixture.Participant1
      : fixture.Participant2;
    const away = fixture.Participant1IsHome
      ? fixture.Participant2
      : fixture.Participant1;
    await pool.query(
      `INSERT INTO fixture_catalog (
         fixture_id, home_name, away_name, competition_name, scheduled_start, provider_status, safe_metadata
       ) VALUES ($1,$2,$3,$4,to_timestamp($5::numeric / 1000),'scheduled',$6::jsonb)
       ON CONFLICT (fixture_id) DO UPDATE SET home_name = EXCLUDED.home_name, away_name = EXCLUDED.away_name,
         competition_name = EXCLUDED.competition_name, scheduled_start = EXCLUDED.scheduled_start,
         safe_metadata = EXCLUDED.safe_metadata, updated_at = clock_timestamp()`,
      [
        String(fixture.FixtureId),
        home,
        away,
        fixture.Competition,
        startMilliseconds.toString(),
        JSON.stringify({ competitionId: fixture.CompetitionId }),
      ],
    );
  }
}

async function consumeFixture(
  config: ServiceConfig,
  pool: DatabasePool,
  logger: ListenerLogger,
  credentials: Credentials,
  fixtureId: bigint,
  signal: AbortSignal,
): Promise<void> {
  let reconnectDelay = 500;
  while (!signal.aborted) {
    try {
      await reconcileRecentIntervals(
        config,
        pool,
        credentials,
        fixtureId,
        signal,
      );
      const cursor = await pool.query<{ last_sse_id: string | null }>(
        "SELECT last_sse_id FROM txline_cursors WHERE fixture_id = $1",
        [fixtureId.toString()],
      );
      await consumeStream(
        config,
        pool,
        credentials,
        fixtureId,
        cursor.rows[0]?.last_sse_id ?? undefined,
        signal,
      );
      reconnectDelay = 500;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TxlineEntitlementError) {
        await publishDegraded(pool, fixtureId, "txline_entitlement");
        throw error;
      }
      logger.warn(
        {
          fixtureId: fixtureId.toString(),
          error: safeMessage(error),
          reconnectDelay,
        },
        "TxLINE disconnected; recovering from cursor",
      );
      await delay(reconnectDelay, signal);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    }
  }
}

async function consumeStream(
  config: ServiceConfig,
  pool: DatabasePool,
  credentials: Credentials,
  fixtureId: bigint,
  lastEventId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL("/api/scores/stream", config.TXLINE_API_ORIGIN);
  url.searchParams.set("fixtureId", fixtureId.toString());
  let response = await authenticatedFetch(
    url,
    credentials,
    lastEventId,
    signal,
  );
  if (response.status === 401) {
    credentials.guestJwt = await renewGuestJwt(config, signal);
    response = await authenticatedFetch(url, credentials, lastEventId, signal);
  }
  if (response.status === 403)
    throw new TxlineEntitlementError(
      "TxLINE returned 403 for the Devnet subscription",
    );
  if (!response.ok || !response.body)
    throw new Error(`TxLINE stream returned ${response.status}`);
  await pool.query(
    `INSERT INTO txline_cursors (fixture_id, subscription_key, last_sse_id, connected_at, heartbeat_at)
     VALUES ($1,'devnet-world-cup',$2,clock_timestamp(),clock_timestamp())
     ON CONFLICT (fixture_id) DO UPDATE SET connected_at = clock_timestamp(), updated_at = clock_timestamp()`,
    [fixtureId.toString(), lastEventId ?? null],
  );
  let pipeline = Promise.resolve();
  const parser = createTxlineSseParser((event) => {
    pipeline = pipeline.then(async () => {
      const record = parseTxlineRecord(event.data);
      requireFixture(record, fixtureId);
      if (record.action === "heartbeat") {
        await updateCursor(pool, fixtureId, event.id, record.seq, true);
        return;
      }
      await ingestTxlineRecord(config, pool, record, event.rawData, event.id);
    });
  });
  const reader = response.body.getReader();
  try {
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done) break;
      parser.feed(item.value);
      await pipeline;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    parser.reset();
  }
}

async function reconcileRecentIntervals(
  config: ServiceConfig,
  pool: DatabasePool,
  credentials: Credentials,
  fixtureId: bigint,
  signal: AbortSignal,
): Promise<void> {
  const now = new Date();
  const checkpoint = await pool.query<{ from_ms: string }>(
    `SELECT COALESCE(
       (SELECT max(provider_ts_ms) FROM txline_events WHERE fixture_id = $1),
       (SELECT floor(extract(epoch FROM greatest(scheduled_start, clock_timestamp() - interval '8 hours')) * 1000)::bigint
          FROM campaign_projections WHERE fixture_id = $1 AND state = 'active' ORDER BY scheduled_start DESC LIMIT 1),
       floor(extract(epoch FROM clock_timestamp() - interval '2 hours') * 1000)::bigint
     )::text AS from_ms`,
    [fixtureId.toString()],
  );
  const fromMs = Number(checkpoint.rows[0]?.from_ms ?? now.getTime());
  const intervalCount = Math.min(
    100,
    Math.max(2, Math.ceil((now.getTime() - fromMs) / 300_000) + 2),
  );
  for (let index = intervalCount - 1; index >= 0; index -= 1) {
    const target = new Date(now.getTime() - index * 300_000);
    const epochDay = Math.floor(target.getTime() / 86_400_000);
    const interval = Math.floor(target.getUTCMinutes() / 5);
    const url = new URL(
      `/api/scores/updates/${epochDay}/${target.getUTCHours()}/${interval}`,
      config.TXLINE_API_ORIGIN,
    );
    url.searchParams.set("fixtureId", fixtureId.toString());
    let response = await authenticatedFetch(
      url,
      credentials,
      undefined,
      signal,
    );
    if (response.status === 401) {
      credentials.guestJwt = await renewGuestJwt(config, signal);
      response = await authenticatedFetch(url, credentials, undefined, signal);
    }
    if (response.status === 403)
      throw new TxlineEntitlementError("TxLINE recovery returned 403");
    if (!response.ok)
      throw new Error(`TxLINE recovery returned ${response.status}`);
    const records = await response.json();
    if (!Array.isArray(records))
      throw new Error("TxLINE recovery payload is not an array");
    for (const value of records) {
      const raw = new TextEncoder().encode(JSON.stringify(value));
      const record = parseTxlineRecord(value);
      requireFixture(record, fixtureId);
      await ingestTxlineRecord(config, pool, record, raw);
    }
  }
}

function requireFixture(record: TxlineRecord, expected: bigint): void {
  if (BigInt(record.fixtureId) !== expected)
    throw new Error("TxLINE record fixture does not match subscription");
}

async function authenticatedFetch(
  url: URL,
  credentials: Credentials,
  lastEventId: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${credentials.guestJwt}`,
      "X-Api-Token": credentials.apiToken,
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
    signal,
  });
}

async function renewGuestJwt(
  config: ServiceConfig,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(
    new URL("/auth/guest/start", config.TXLINE_API_ORIGIN),
    { method: "POST", signal },
  );
  if (!response.ok)
    throw new Error(`TxLINE guest renewal returned ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const jwt = body.jwt ?? body.token ?? body.accessToken;
  if (typeof jwt !== "string" || jwt.length < 20)
    throw new Error("TxLINE guest renewal omitted JWT");
  return jwt;
}

export async function ingestTxlineRecord(
  config: ServiceConfig,
  pool: DatabasePool,
  record: TxlineRecord,
  rawBytes: Uint8Array,
  sseId?: string,
): Promise<"inserted" | "duplicate"> {
  const decision = decideRecord(record, rawBytes);
  const fixtureId = BigInt(record.fixtureId);
  const seq = BigInt(record.seq);
  const actionId = record.id === undefined ? null : BigInt(record.id);
  const traceId = randomUUID();
  const rawDigest =
    decision.kind === "qualifying_goal"
      ? decision.goal.rawDigest
      : sha256(rawBytes);
  const raw = config.TXLINE_RAW_RETENTION_ENABLED
    ? encryptRaw(rawBytes, config.TXLINE_RAW_ENCRYPTION_KEY ?? "")
    : null;
  const storedDecision =
    decision.kind === "audit_only"
      ? decision.reason === "discard"
        ? "discarded"
        : "correction"
      : decision.kind;
  const normalized = jsonSafe(decision);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO txline_events (
         fixture_id, action_id, seq, provider_ts_ms, action, adapter_version, normalized,
         raw_digest, encrypted_raw_payload, raw_delete_after, decision
       ) VALUES ($1,$2,$3,$4,$5,'txline-soccer-v1',$6::jsonb,$7,$8,
                 CASE WHEN $8::bytea IS NULL THEN NULL ELSE clock_timestamp() + interval '24 hours' END,$9)
       ON CONFLICT (fixture_id, seq) DO NOTHING RETURNING id`,
      [
        fixtureId.toString(),
        actionId?.toString() ?? null,
        seq.toString(),
        BigInt(record.ts).toString(),
        record.action,
        JSON.stringify(normalized),
        Buffer.from(rawDigest),
        raw,
        storedDecision,
      ],
    );
    await updateCursor(client, fixtureId, sseId, record.seq, false);
    if (inserted.rowCount !== 1) {
      await client.query("COMMIT");
      return "duplicate";
    }
    await client.query(
      `UPDATE fixture_catalog SET provider_status = $2, updated_at = clock_timestamp() WHERE fixture_id = $1`,
      [
        fixtureId.toString(),
        decision.kind === "terminal" ? "completed" : "live",
      ],
    );
    const campaign = await client.query<{ campaign: string }>(
      "SELECT campaign FROM campaign_projections WHERE fixture_id = $1 AND state = 'active' AND terminal_reason = 'none'",
      [fixtureId.toString()],
    );
    const campaignAddress = campaign.rows[0]?.campaign;
    if (decision.kind === "qualifying_goal") {
      const latenessMs = BigInt(Date.now()) - decision.goal.providerTsMs;
      const isLate =
        latenessMs > BigInt(config.LIVE_EVENT_MAX_LATENESS_SECONDS * 1_000);
      const goal = await client.query(
        `INSERT INTO goal_decisions (
           event_key, fixture_id, action_id, qualifying, reason, campaign, oracle_status, raw_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
        [
          Buffer.from(decision.goal.eventKey),
          fixtureId.toString(),
          decision.goal.actionId.toString(),
          !isLate,
          isLate ? "late_not_opened" : "qualifying_status",
          campaignAddress ?? null,
          !campaignAddress || isLate ? "late" : "queued",
          Buffer.from(decision.goal.rawDigest),
        ],
      );
      if (goal.rowCount === 1 && campaignAddress && !isLate) {
        const safePayload = {
          campaign: campaignAddress,
          fixtureId: fixtureId.toString(),
          eventKey: Buffer.from(decision.goal.eventKey).toString("hex"),
          providerTimestampMs: decision.goal.providerTsMs.toString(),
          source: "live",
        };
        await client.query(
          `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
           VALUES ('goal',$1,'goal.qualifying',$2::jsonb,$3)`,
          [
            Buffer.from(decision.goal.eventKey).toString("hex"),
            JSON.stringify({
              ...safePayload,
              actionId: decision.goal.actionId.toString(),
              seq: decision.goal.seq,
              status: decision.goal.statusSoccerId,
              confirmed: decision.goal.confirmed,
              rawDigest: Buffer.from(decision.goal.rawDigest).toString("hex"),
            }),
            traceId,
          ],
        );
        if (config.TXLINE_PUBLIC_OUTPUT_ENABLED) {
          await client.query(
            "INSERT INTO application_events (campaign, event_type, safe_payload, trace_id) VALUES ($1,'goal.detected',$2::jsonb,$3)",
            [campaignAddress, JSON.stringify(safePayload), traceId],
          );
        }
      }
    } else if (decision.kind === "terminal" && campaignAddress) {
      await client.query(
        `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
         VALUES ('campaign',$1,'match.complete',$2::jsonb,$3)`,
        [
          campaignAddress,
          JSON.stringify({
            campaign: campaignAddress,
            fixtureId: fixtureId.toString(),
            seq: seq.toString(),
          }),
          traceId,
        ],
      );
    } else if (decision.kind === "audit_only") {
      await client.query(
        `INSERT INTO audit_log (actor_type, actor_key, action, target_type, target_key, after_digest, trace_id)
         VALUES ('txline',$1,$2,'goal',$3,$4,$5)`,
        [
          fixtureId.toString(),
          decision.reason,
          decision.originalActionId.toString(),
          Buffer.from(rawDigest),
          traceId,
        ],
      );
    }
    await client.query("COMMIT");
    return "inserted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateCursor(
  database: Pick<DatabasePool, "query">,
  fixtureId: bigint,
  sseId: string | undefined,
  seq: string | number,
  heartbeat: boolean,
): Promise<void> {
  await database.query(
    `INSERT INTO txline_cursors (fixture_id, subscription_key, last_sse_id, last_seq, heartbeat_at)
     VALUES ($1,'devnet-world-cup',$2,$3,CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)
     ON CONFLICT (fixture_id) DO UPDATE SET
       last_sse_id = COALESCE(EXCLUDED.last_sse_id, txline_cursors.last_sse_id),
       last_seq = GREATEST(txline_cursors.last_seq, EXCLUDED.last_seq),
       heartbeat_at = CASE WHEN $4 THEN clock_timestamp() ELSE txline_cursors.heartbeat_at END,
       updated_at = clock_timestamp()`,
    [fixtureId.toString(), sseId ?? null, BigInt(seq).toString(), heartbeat],
  );
}

function encryptRaw(raw: Uint8Array, encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32)
    throw new Error("TXLINE_RAW_ENCRYPTION_KEY must decode to 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "bigint"
        ? nested.toString()
        : nested instanceof Uint8Array
          ? Buffer.from(nested).toString("hex")
          : nested,
    ),
  );
}

async function publishDegraded(
  pool: DatabasePool,
  fixtureId: bigint,
  reason: string,
): Promise<void> {
  const campaigns = await pool.query<{ campaign: string }>(
    "SELECT campaign FROM campaign_projections WHERE fixture_id = $1 AND state = 'active'",
    [fixtureId.toString()],
  );
  for (const row of campaigns.rows) {
    await pool.query(
      "INSERT INTO application_events (campaign, event_type, safe_payload, trace_id) VALUES ($1,'service.degraded',$2::jsonb,$3)",
      [
        row.campaign,
        JSON.stringify({ service: "live_feed", reason }),
        randomUUID(),
      ],
    );
  }
}

class TxlineEntitlementError extends Error {}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
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

import { randomUUID } from "node:crypto";
import type { DatabasePool } from "@goaldrop/db";

export interface ReadyDemoCampaign {
  campaign: string;
  remainingGoals: number;
}

interface RuntimeRow {
  generation: string;
  status: "idle" | "preparing" | "ready" | "failed";
  campaign: string | null;
  last_error: string | null;
  updated_at: Date;
}

const PREPARATION_STALE_AFTER_MS = 120_000;

export async function findReadyDemoCampaign(
  pool: DatabasePool,
  roundCount: number,
): Promise<ReadyDemoCampaign | null> {
  const result = await pool.query<{
    campaign: string;
    opened_rounds: string;
  }>(
    `SELECT runtime.campaign, count(rounds.round)::text AS opened_rounds
     FROM demo_runtime runtime
     JOIN demo_campaigns managed
       ON managed.campaign = runtime.campaign AND managed.is_current AND managed.status = 'ready'
     JOIN campaign_projections campaign ON campaign.campaign = runtime.campaign
     LEFT JOIN round_projections rounds ON rounds.campaign = campaign.campaign
     WHERE runtime.singleton AND runtime.status = 'ready'
       AND campaign.state = 'active' AND campaign.terminal_reason = 'none'
       AND campaign.registration_deadline > clock_timestamp() + interval '15 minutes'
       AND campaign.hard_expiry > clock_timestamp() + interval '20 minutes'
     GROUP BY runtime.campaign
     HAVING count(rounds.round) < $1`,
    [roundCount],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    campaign: row.campaign,
    remainingGoals: Math.max(0, roundCount - Number(row.opened_rounds)),
  };
}

export async function ensureReadyDemoCampaign(
  pool: DatabasePool,
  roundCount: number,
  timeoutMs = 75_000,
): Promise<ReadyDemoCampaign> {
  const existing = await findReadyDemoCampaign(pool, roundCount);
  if (existing) return existing;

  const generation = await requestDemoPreparation(pool);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    const ready = await findReadyDemoCampaign(pool, roundCount);
    if (ready) return ready;
    const runtime = await readRuntime(pool);
    if (
      runtime.status === "failed" &&
      BigInt(runtime.generation) === generation
    ) {
      throw new Error(
        "Demo preparation failed. Please press Start to retry safely.",
      );
    }
  }
  throw new Error(
    "Demo preparation is still finishing. Please press Start again in a moment.",
  );
}

async function requestDemoPreparation(pool: DatabasePool): Promise<bigint> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<RuntimeRow>(
      `SELECT generation::text, status, campaign, last_error, updated_at
       FROM demo_runtime WHERE singleton FOR UPDATE`,
    );
    const runtime = current.rows[0];
    if (!runtime) throw new Error("demo runtime is not initialized");
    const preparingIsFresh =
      runtime.status === "preparing" &&
      runtime.updated_at.getTime() > Date.now() - PREPARATION_STALE_AFTER_MS;
    if (preparingIsFresh) {
      await client.query("COMMIT");
      return BigInt(runtime.generation);
    }

    const generation = BigInt(runtime.generation) + 1n;
    const traceId = randomUUID();
    await client.query(
      `UPDATE demo_runtime SET generation = $1, status = 'preparing', campaign = NULL,
         last_error = NULL, updated_at = clock_timestamp() WHERE singleton`,
      [generation.toString()],
    );
    await client.query(
      `UPDATE demo_campaigns SET is_current = false,
         status = CASE WHEN status = 'ready' THEN 'retiring' ELSE status END,
         updated_at = clock_timestamp()
       WHERE is_current`,
    );
    await client.query(
      `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
       VALUES ('demo-runtime',$1,'demo.prepare',$2::jsonb,$3)`,
      [
        generation.toString(),
        JSON.stringify({ generation: generation.toString() }),
        traceId,
      ],
    );
    await client.query("COMMIT");
    return generation;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readRuntime(pool: DatabasePool): Promise<RuntimeRow> {
  const result = await pool.query<RuntimeRow>(
    `SELECT generation::text, status, campaign, last_error, updated_at
     FROM demo_runtime WHERE singleton`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("demo runtime is not initialized");
  return row;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import type { PublicEventType } from "@goaldrop/protocol";
import type { DatabasePool } from "./pool.js";

export interface ApplicationEvent {
  id: bigint;
  campaign: string | null;
  eventType: PublicEventType;
  payload: unknown;
  traceId: string;
  createdAt: Date;
}

export async function readApplicationEvents(
  pool: DatabasePool,
  campaign: string,
  after: bigint,
  limit = 100,
): Promise<ApplicationEvent[]> {
  const result = await pool.query<{
    id: string;
    campaign: string | null;
    event_type: PublicEventType;
    safe_payload: unknown;
    trace_id: string;
    created_at: Date;
  }>(
    `SELECT id, campaign, event_type, safe_payload, trace_id, created_at
     FROM application_events WHERE campaign = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
    [campaign, after.toString(), Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows.map((row) => ({
    id: BigInt(row.id),
    campaign: row.campaign,
    eventType: row.event_type,
    payload: row.safe_payload,
    traceId: row.trace_id,
    createdAt: row.created_at,
  }));
}

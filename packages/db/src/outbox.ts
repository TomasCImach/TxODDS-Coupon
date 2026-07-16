import type { DatabasePool } from "./pool.js";

export interface OutboxMessage {
  id: bigint;
  aggregateType: string;
  aggregateKey: string;
  eventType: string;
  payload: unknown;
  traceId: string;
  attempts: number;
}

export async function claimOutboxBatch(
  pool: DatabasePool,
  eventTypes?: readonly string[],
  limit = 50,
): Promise<OutboxMessage[]> {
  const result = await pool.query<{
    id: string;
    aggregate_type: string;
    aggregate_key: string;
    event_type: string;
    payload: unknown;
    trace_id: string;
    attempts: number;
  }>(
    `UPDATE outbox SET attempts = attempts + 1,
                       available_at = clock_timestamp() + interval '30 seconds'
     WHERE id IN (
       SELECT id FROM outbox WHERE published_at IS NULL AND dead_lettered_at IS NULL
         AND available_at <= clock_timestamp()
         AND ($1::text[] IS NULL OR event_type = ANY($1::text[]))
       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
     )
     RETURNING id, aggregate_type, aggregate_key, event_type, payload, trace_id, attempts`,
    [
      eventTypes && eventTypes.length > 0 ? [...eventTypes] : null,
      Math.min(Math.max(limit, 1), 200),
    ],
  );
  return result.rows.map((row) => ({
    id: BigInt(row.id),
    aggregateType: row.aggregate_type,
    aggregateKey: row.aggregate_key,
    eventType: row.event_type,
    payload: row.payload,
    traceId: row.trace_id,
    attempts: row.attempts,
  }));
}

export async function markOutboxPublished(
  pool: DatabasePool,
  id: bigint,
): Promise<void> {
  await pool.query(
    "UPDATE outbox SET published_at = clock_timestamp(), last_error = NULL WHERE id = $1",
    [id.toString()],
  );
}

export async function deferOutbox(
  pool: DatabasePool,
  id: bigint,
  error: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      aggregate_type: string;
      aggregate_key: string;
      trace_id: string;
      dead_lettered_at: Date | null;
    }>(
      `UPDATE outbox SET
         available_at = CASE WHEN attempts >= 12 THEN available_at
           ELSE clock_timestamp() + make_interval(secs => LEAST(60, power(2, LEAST(attempts, 6))::integer)) END,
         dead_lettered_at = CASE WHEN attempts >= 12 THEN COALESCE(dead_lettered_at, clock_timestamp())
           ELSE dead_lettered_at END,
         last_error = left($2, 500)
       WHERE id = $1
       RETURNING aggregate_type, aggregate_key, trace_id, dead_lettered_at`,
      [id.toString(), error],
    );
    const row = result.rows[0];
    if (row?.dead_lettered_at) {
      if (row.aggregate_type === "claim")
        await client.query(
          `UPDATE claim_requests SET status = 'failed', error_code = left($2,500), updated_at = clock_timestamp()
           WHERE receipt_id = $1::uuid AND status NOT IN ('confirmed','finalized','missed','expired')`,
          [row.aggregate_key, error],
        );
      if (row.aggregate_type === "registration")
        await client.query(
          `UPDATE registration_requests SET status = 'failed', error_code = left($2,500), updated_at = clock_timestamp()
           WHERE id = $1::uuid AND status NOT IN ('confirmed','finalized')`,
          [row.aggregate_key, error],
        );
      await client.query(
        `INSERT INTO audit_log (actor_type, action, target_type, target_key, reason, trace_id)
         VALUES ('worker','outbox_dead_letter','outbox',$1,left($2,500),$3)`,
        [id.toString(), error, row.trace_id],
      );
    }
    await client.query("COMMIT");
  } catch (failure) {
    await client.query("ROLLBACK");
    throw failure;
  } finally {
    client.release();
  }
}

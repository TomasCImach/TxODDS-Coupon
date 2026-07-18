import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensureReadyDemoCampaign } from "../demo-runtime.js";
import { requireWriteOrigin } from "../origin.js";
import type { RouteDependencies } from "./types.js";

const sessionParams = z.object({ id: z.string().min(30).max(100) });

export async function registerDemoRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  app.post(
    "/v1/demo/sessions",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["demo"],
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      if (!deps.config.DEMO_MODE_ENABLED)
        throw new Error("Demo Mode is unavailable");
      const demo = await ensureReadyDemoCampaign(
        deps.pool,
        deps.config.DEMO_ROUND_COUNT,
      );
      const capability = randomBytes(32).toString("base64url");
      await deps.pool.query(
        `INSERT INTO demo_sessions (session_hash, campaign, origin, expires_at)
       VALUES ($1,$2,$3,clock_timestamp() + interval '15 minutes')`,
        [
          Buffer.from(sha256(new TextEncoder().encode(capability))),
          demo.campaign,
          origin,
        ],
      );
      return {
        id: capability,
        campaign: demo.campaign,
        expiresInSeconds: 900,
        remainingGoals: demo.remainingGoals,
        label: "SIMULATED DEVNET EVENT",
      };
    },
  );

  app.post(
    "/v1/demo/sessions/:id/goal",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["demo"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", maxLength: 100 } },
        },
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const { id } = sessionParams.parse(request.params);
      const traceId = request.id.length === 36 ? request.id : randomUUID();
      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");
        const session = await client.query<{ campaign: string; step: number }>(
          `UPDATE demo_sessions SET step = step + 1, request_count = request_count + 1, last_request_at = clock_timestamp()
         WHERE session_hash = $1 AND origin = $2 AND expires_at >= clock_timestamp()
           AND request_count < 20 AND step < $3
           AND (last_request_at IS NULL OR last_request_at <= clock_timestamp() - interval '1 second')
         RETURNING campaign, step`,
          [
            Buffer.from(sha256(new TextEncoder().encode(id))),
            origin,
            deps.config.DEMO_ROUND_COUNT,
          ],
        );
        const row = session.rows[0];
        if (!row)
          throw new Error("demo capability expired or rate limit exceeded");
        await client.query(
          `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
         VALUES ('demo', $1, 'demo.goal', $2::jsonb, $3)`,
          [
            row.campaign,
            JSON.stringify({
              campaign: row.campaign,
              step: row.step,
              label: "SIMULATED DEVNET EVENT",
            }),
            traceId,
          ],
        );
        await client.query("COMMIT");
        return {
          status: "opening",
          campaign: row.campaign,
          step: row.step,
          remainingGoals: Math.max(0, deps.config.DEMO_ROUND_COUNT - row.step),
          label: "SIMULATED DEVNET EVENT",
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/v1/demo/sessions/:id/complete",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["demo"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", maxLength: 100 } },
        },
        body: { type: "object", additionalProperties: false, properties: {} },
      },
    },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const { id } = sessionParams.parse(request.params);
      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ campaign: string }>(
          `DELETE FROM demo_sessions WHERE session_hash = $1 AND origin = $2 AND expires_at >= clock_timestamp()
           RETURNING campaign`,
          [Buffer.from(sha256(new TextEncoder().encode(id))), origin],
        );
        const campaign = result.rows[0]?.campaign;
        if (!campaign) throw new Error("demo capability expired");
        await client.query(
          `INSERT INTO outbox (aggregate_type, aggregate_key, event_type, payload, trace_id)
           VALUES ('demo', $1, 'demo.complete', $2::jsonb, $3)`,
          [
            campaign,
            JSON.stringify({ campaign, label: "SIMULATED DEVNET EVENT" }),
            request.id.length === 36 ? request.id : randomUUID(),
          ],
        );
        await client.query(
          `UPDATE demo_campaigns SET is_current = false,
             status = CASE WHEN status = 'ready' THEN 'retiring' ELSE status END,
             updated_at = clock_timestamp()
           WHERE campaign = $1`,
          [campaign],
        );
        await client.query(
          `UPDATE demo_runtime SET status = 'idle', campaign = NULL,
             updated_at = clock_timestamp()
           WHERE singleton AND campaign = $1`,
          [campaign],
        );
        await client.query("COMMIT");
        return {
          status: "completing",
          campaign,
          label: "SIMULATED DEVNET EVENT",
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}

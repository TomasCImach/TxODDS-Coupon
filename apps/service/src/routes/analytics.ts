import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWriteOrigin } from "../origin.js";
import type { RouteDependencies } from "./types.js";

const eventNames = [
  "campaign_viewed",
  "wallet_path_selected",
  "registration_started",
  "registration_completed",
  "claim_started",
  "claim_receipt_accepted",
  "claim_confirmed",
  "claim_missed",
  "transfer_started",
  "transfer_completed",
  "sponsor_setup_started",
  "campaign_created",
  "campaign_funded",
  "campaign_activated",
  "campaign_refunded",
  "demo_session_started",
  "demo_goal_triggered",
  "demo_completed",
  "product_error",
] as const;
const forbiddenProperty =
  /wallet|address|signature|nonce|passkey|email|name|destination|secret|token_account/i;
const propertyValue = z.union([
  z.string().max(100),
  z.number().finite(),
  z.boolean(),
]);
const analyticsEvent = z
  .object({
    eventId: z.string().uuid(),
    eventName: z.enum(eventNames),
    campaign: z.string().min(32).max(44).optional(),
    occurredAt: z.string().datetime(),
    properties: z.record(z.string().max(40), propertyValue).default({}),
  })
  .superRefine((event, context) => {
    for (const key of Object.keys(event.properties)) {
      if (forbiddenProperty.test(key))
        context.addIssue({
          code: "custom",
          message: `analytics property ${key} is prohibited`,
        });
    }
    const occurred = new Date(event.occurredAt).getTime();
    if (Math.abs(Date.now() - occurred) > 86_400_000)
      context.addIssue({
        code: "custom",
        message: "analytics timestamp is outside the accepted window",
      });
  });
const batch = z.object({
  sessionId: z.string().uuid(),
  events: z.array(analyticsEvent).min(1).max(20),
});

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  app.post(
    "/v1/analytics/events",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["public"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "events"],
          properties: {
            sessionId: { type: "string", format: "uuid" },
            events: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      requireWriteOrigin(request, deps.config);
      const input = batch.parse(request.body);
      for (const event of input.events) {
        await deps.pool.query(
          `INSERT INTO analytics_events (event_id, session_id, event_name, campaign, properties, occurred_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (event_id) DO NOTHING`,
          [
            event.eventId,
            input.sessionId,
            event.eventName,
            event.campaign ?? null,
            JSON.stringify(event.properties),
            event.occurredAt,
          ],
        );
      }
      reply.code(202);
      return { accepted: input.events.length };
    },
  );
}

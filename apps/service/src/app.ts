import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type { RouteDependencies } from "./routes/types.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerFanRoutes } from "./routes/fan.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerTransactionRoutes } from "./routes/transactions.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { runApiMaintenance } from "./maintenance.js";
import { readFeePayerBalance } from "./fee-payer-admission.js";

export async function createApp(
  deps: RouteDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    trustProxy:
      deps.config.TRUST_PROXY_HOPS === 0 ? false : deps.config.TRUST_PROXY_HOPS,
    logger:
      deps.config.LOG_LEVEL === "silent"
        ? false
        : {
            level: deps.config.LOG_LEVEL,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.x-api-key",
                "req.headers.cookie",
                "req.url",
                "body.signature",
                "body.nonce",
                "body.capability",
                "TXLINE_GUEST_JWT",
                "TXLINE_API_TOKEN",
                "RELAYER_KEYPAIR",
                "ORACLE_KEYPAIR",
                "DEMO_AUTHORITY_KEYPAIR",
                "FEE_PAYER_KEYPAIR",
              ],
              censor: "[REDACTED]",
            },
          },
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(sensible);
  await app.register(cors, {
    origin: deps.config.PUBLIC_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "last-event-id", "x-request-id"],
    credentials: false,
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    ban: 2,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      error: "rate_limited",
      message: "Too many requests; retry shortly.",
    }),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "GoalDrop Devnet MVP API", version: "1.0.0" },
      servers: [{ url: "/", description: "Current Devnet service" }],
      tags: [
        { name: "public" },
        { name: "fan" },
        { name: "demo" },
        { name: "sponsor" },
      ],
    },
  });
  if (deps.config.NODE_ENV !== "production") {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }

  const metrics = createMetrics();
  app.addHook("onResponse", async (request, reply) => {
    metrics.requests.inc({
      route: request.routeOptions.url ?? "unknown",
      method: request.method,
      status: String(reply.statusCode),
    });
    const elapsed = reply.elapsedTime / 1_000;
    metrics.duration.observe(
      { route: request.routeOptions.url ?? "unknown", method: request.method },
      elapsed,
    );
  });
  app.get("/internal/metrics", async (_request, reply) => {
    const [operational, campaigns, rounds, claims, txline] = await Promise.all([
      deps.pool.query<{
        pending_claims: string;
        pending_outbox: string;
        dead_lettered_outbox: string;
        stale_txline_cursors: string;
        ambiguous_transactions: string;
        overdue_raw_payloads: string;
        registrations: string;
        winners: string;
        paid_base_units: string;
        external_inflow_base_units: string;
        refundable_residual_base_units: string;
        oldest_outbox_age_seconds: string;
        txline_heartbeat_age_seconds: string;
        txline_last_event_age_seconds: string;
      }>(`SELECT
        (SELECT count(*) FROM claim_requests WHERE status IN ('accepted','submitted'))::text AS pending_claims,
        (SELECT count(*) FROM outbox WHERE published_at IS NULL AND dead_lettered_at IS NULL)::text AS pending_outbox,
        (SELECT count(*) FROM outbox WHERE dead_lettered_at IS NOT NULL)::text AS dead_lettered_outbox,
        (SELECT count(*) FROM txline_cursors WHERE heartbeat_at IS NULL OR heartbeat_at < clock_timestamp() - interval '2 minutes')::text AS stale_txline_cursors,
        ((SELECT count(*) FROM sponsored_transaction_templates WHERE status = 'ambiguous')
          + (SELECT count(*) FROM chain_transactions WHERE status = 'ambiguous'))::text AS ambiguous_transactions,
        (SELECT count(*) FROM txline_events WHERE encrypted_raw_payload IS NOT NULL AND raw_delete_after <= clock_timestamp())::text AS overdue_raw_payloads,
        (SELECT count(*) FROM registration_projections)::text AS registrations,
        (SELECT COALESCE(sum(winner_count), 0) FROM round_projections)::text AS winners,
        (SELECT COALESCE(sum(paid_amount), 0) FROM campaign_projections)::text AS paid_base_units,
        (SELECT COALESCE(sum(external_inflow_total), 0) FROM campaign_projections)::text AS external_inflow_base_units,
        (SELECT COALESCE(sum(GREATEST(funded_amount + external_inflow_total - paid_amount - refunded_amount, 0)) FILTER (WHERE state = 'refundable'), 0) FROM campaign_projections)::text AS refundable_residual_base_units,
        (SELECT COALESCE(EXTRACT(epoch FROM clock_timestamp() - min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)), 0) FROM outbox)::text AS oldest_outbox_age_seconds,
        (SELECT COALESCE(EXTRACT(epoch FROM clock_timestamp() - max(heartbeat_at)), 0) FROM txline_cursors)::text AS txline_heartbeat_age_seconds,
        (SELECT COALESCE(EXTRACT(epoch FROM clock_timestamp() - max(received_at)), 0) FROM txline_events)::text AS txline_last_event_age_seconds`),
      deps.pool.query<{ state: string; count: string }>(
        "SELECT state, count(*)::text AS count FROM campaign_projections GROUP BY state",
      ),
      deps.pool.query<{ state: string; source: string; count: string }>(
        "SELECT state, source, count(*)::text AS count FROM round_projections GROUP BY state, source",
      ),
      deps.pool.query<{ status: string; count: string }>(
        "SELECT status, count(*)::text AS count FROM claim_requests GROUP BY status",
      ),
      deps.pool.query<{ decision: string; count: string }>(
        "SELECT decision, count(*)::text AS count FROM txline_events GROUP BY decision",
      ),
    ]);
    const state = operational.rows[0];
    metrics.pendingClaims.set(Number(state?.pending_claims ?? 0));
    metrics.pendingOutbox.set(Number(state?.pending_outbox ?? 0));
    metrics.deadLetteredOutbox.set(Number(state?.dead_lettered_outbox ?? 0));
    metrics.staleTxlineCursors.set(Number(state?.stale_txline_cursors ?? 0));
    metrics.ambiguousTransactions.set(
      Number(state?.ambiguous_transactions ?? 0),
    );
    metrics.overdueRawPayloads.set(Number(state?.overdue_raw_payloads ?? 0));
    metrics.registrations.set(Number(state?.registrations ?? 0));
    metrics.winners.set(Number(state?.winners ?? 0));
    metrics.paidBaseUnits.set(Number(state?.paid_base_units ?? 0));
    metrics.externalInflowBaseUnits.set(
      Number(state?.external_inflow_base_units ?? 0),
    );
    metrics.refundableResidualBaseUnits.set(
      Number(state?.refundable_residual_base_units ?? 0),
    );
    metrics.oldestOutboxAgeSeconds.set(
      Number(state?.oldest_outbox_age_seconds ?? 0),
    );
    metrics.txlineHeartbeatAgeSeconds.set(
      Number(state?.txline_heartbeat_age_seconds ?? 0),
    );
    metrics.txlineLastEventAgeSeconds.set(
      Number(state?.txline_last_event_age_seconds ?? 0),
    );
    metrics.campaigns.reset();
    for (const row of campaigns.rows)
      metrics.campaigns.set({ state: row.state }, Number(row.count));
    metrics.rounds.reset();
    for (const row of rounds.rows)
      metrics.rounds.set(
        { state: row.state, source: row.source },
        Number(row.count),
      );
    metrics.claims.reset();
    for (const row of claims.rows)
      metrics.claims.set({ status: row.status }, Number(row.count));
    metrics.txlineDecisions.reset();
    for (const row of txline.rows)
      metrics.txlineDecisions.set(
        { decision: row.decision },
        Number(row.count),
      );
    metrics.databasePoolConnections.reset();
    metrics.databasePoolConnections.set(
      { state: "total" },
      deps.pool.totalCount,
    );
    metrics.databasePoolConnections.set({ state: "idle" }, deps.pool.idleCount);
    metrics.databasePoolConnections.set(
      { state: "waiting" },
      deps.pool.waitingCount,
    );
    try {
      const balance = await readFeePayerBalance(deps.config);
      metrics.feePayerLamports.set(balance);
      metrics.sponsoredAdmissionOpen.set(
        balance >= deps.config.FEE_PAYER_MIN_LAMPORTS ? 1 : 0,
      );
    } catch {
      metrics.feePayerLamports.set(0);
      metrics.sponsoredAdmissionOpen.set(0);
    }
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  app.get("/internal/health", async () => {
    await deps.pool.query("SELECT 1");
    return {
      status: "ok",
      role: deps.config.role,
      onchainConfig: deps.onchain.address.toBase58(),
      authorityEpoch: deps.onchain.authorityEpoch,
    };
  });

  let maintenanceTimer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    const maintain = async () => {
      try {
        const result = await runApiMaintenance(deps.pool);
        if (Object.values(result).some((count) => count > 0))
          app.log.info(result, "expired API data removed");
      } catch (error) {
        app.log.error({ err: error }, "API retention job failed");
      }
    };
    await maintain();
    maintenanceTimer = setInterval(() => void maintain(), 15 * 60_000);
    maintenanceTimer.unref();
  });
  app.addHook("onClose", async () => {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
  });

  await registerPublicRoutes(app, deps);
  await registerFanRoutes(app, deps);
  await registerDemoRoutes(app, deps);
  await registerTransactionRoutes(app, deps);
  await registerAnalyticsRoutes(app, deps);

  app.setErrorHandler((error, request, reply) => {
    const caught =
      error instanceof Error ? error : new Error("Unknown request error");
    request.log.warn(
      {
        err: { name: caught.name, message: caught.message },
        requestId: request.id,
      },
      "request rejected",
    );
    if (reply.sent) return;
    const response = classifyRequestError(error, caught);
    const status = response.status;
    reply.code(status).send({
      error: response.error,
      message: response.message,
      requestId: request.id,
    });
  });
  return app;
}

export function classifyRequestError(
  original: unknown,
  caught = original instanceof Error
    ? original
    : new Error("Unknown request error"),
): { status: number; error: string; message: string } {
  const validation =
    typeof original === "object" &&
    original !== null &&
    "validation" in original;
  const infrastructure =
    /unavailable|database|rpc|econnrefused|econnreset|connection (?:ended|terminated)|socket|network|fetch failed|timeout|timed out|rate.?limit|\b429\b|\b503\b/i.test(
      caught.message,
    );
  const status =
    validation || caught.name === "ZodError"
      ? 400
      : /not found/i.test(caught.message)
        ? 404
        : /duplicate|already|not open|\bexpired\b|\bused\b|\bstate\b/i.test(
              caught.message,
            )
          ? 409
          : infrastructure
            ? 503
            : 400;
  return {
    status,
    error: status === 503 ? "service_unavailable" : "request_rejected",
    message:
      status === 503
        ? "Service temporarily unavailable; retry shortly."
        : caught.message,
  };
}

function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "goaldrop_" });
  const requests = new Counter({
    name: "goaldrop_http_requests_total",
    help: "HTTP responses",
    labelNames: ["route", "method", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "goaldrop_http_request_duration_seconds",
    help: "HTTP response latency",
    labelNames: ["route", "method"],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const pendingClaims = new Gauge({
    name: "goaldrop_pending_claims",
    help: "Claims awaiting a terminal chain result",
    registers: [registry],
  });
  const pendingOutbox = new Gauge({
    name: "goaldrop_pending_outbox_events",
    help: "Unpublished durable commands",
    registers: [registry],
  });
  const deadLetteredOutbox = new Gauge({
    name: "goaldrop_dead_lettered_outbox_events",
    help: "Durable commands stopped after the bounded retry budget",
    registers: [registry],
  });
  const staleTxlineCursors = new Gauge({
    name: "goaldrop_stale_txline_cursors",
    help: "TxLINE cursors without a recent heartbeat",
    registers: [registry],
  });
  const ambiguousTransactions = new Gauge({
    name: "goaldrop_ambiguous_transactions",
    help: "Sponsored submissions requiring chain reconciliation",
    registers: [registry],
  });
  const overdueRawPayloads = new Gauge({
    name: "goaldrop_overdue_raw_payloads",
    help: "Encrypted raw payloads past their deletion deadline",
    registers: [registry],
  });
  const feePayerLamports = new Gauge({
    name: "goaldrop_fee_payer_lamports",
    help: "Last observed platform fee-payer balance in lamports",
    registers: [registry],
  });
  const sponsoredAdmissionOpen = new Gauge({
    name: "goaldrop_sponsored_admission_open",
    help: "Whether new fee-sponsored requests currently pass balance admission",
    registers: [registry],
  });
  const campaigns = new Gauge({
    name: "goaldrop_campaigns",
    help: "Campaign projections by bounded lifecycle state",
    labelNames: ["state"],
    registers: [registry],
  });
  const rounds = new Gauge({
    name: "goaldrop_rounds",
    help: "Round projections by bounded lifecycle state and source",
    labelNames: ["state", "source"],
    registers: [registry],
  });
  const claims = new Gauge({
    name: "goaldrop_claim_receipts",
    help: "Durable claim receipts by bounded settlement status",
    labelNames: ["status"],
    registers: [registry],
  });
  const txlineDecisions = new Gauge({
    name: "goaldrop_txline_decisions",
    help: "Persisted TxLINE records by bounded normalization decision",
    labelNames: ["decision"],
    registers: [registry],
  });
  const registrations = new Gauge({
    name: "goaldrop_registrations",
    help: "Confirmed registration projections",
    registers: [registry],
  });
  const winners = new Gauge({
    name: "goaldrop_winners",
    help: "Confirmed winners projected from round accounts",
    registers: [registry],
  });
  const paidBaseUnits = new Gauge({
    name: "goaldrop_paid_base_units",
    help: "Exact reward base units paid by projected campaigns",
    registers: [registry],
  });
  const externalInflowBaseUnits = new Gauge({
    name: "goaldrop_external_inflow_base_units",
    help: "Unsolicited classic SPL base units reconciled by campaigns",
    registers: [registry],
  });
  const refundableResidualBaseUnits = new Gauge({
    name: "goaldrop_refundable_residual_base_units",
    help: "Base units currently available through fixed-destination refund",
    registers: [registry],
  });
  const oldestOutboxAgeSeconds = new Gauge({
    name: "goaldrop_oldest_outbox_age_seconds",
    help: "Age of the oldest unpublished durable command",
    registers: [registry],
  });
  const txlineHeartbeatAgeSeconds = new Gauge({
    name: "goaldrop_txline_heartbeat_age_seconds",
    help: "Age of the newest persisted TxLINE heartbeat",
    registers: [registry],
  });
  const txlineLastEventAgeSeconds = new Gauge({
    name: "goaldrop_txline_last_event_age_seconds",
    help: "Age of the newest persisted TxLINE record",
    registers: [registry],
  });
  const databasePoolConnections = new Gauge({
    name: "goaldrop_database_pool_connections",
    help: "PostgreSQL pool connections by bounded state",
    labelNames: ["state"],
    registers: [registry],
  });
  return {
    registry,
    requests,
    duration,
    pendingClaims,
    pendingOutbox,
    deadLetteredOutbox,
    staleTxlineCursors,
    ambiguousTransactions,
    overdueRawPayloads,
    feePayerLamports,
    sponsoredAdmissionOpen,
    campaigns,
    rounds,
    claims,
    txlineDecisions,
    registrations,
    winners,
    paidBaseUnits,
    externalInflowBaseUnits,
    refundableResidualBaseUnits,
    oldestOutboxAgeSeconds,
    txlineHeartbeatAgeSeconds,
    txlineLastEventAgeSeconds,
    databasePoolConnections,
  };
}

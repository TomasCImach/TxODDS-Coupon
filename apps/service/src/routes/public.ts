import { readApplicationEvents } from "@goaldrop/db";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyReceiptCapability } from "../capability.js";
import type { RouteDependencies } from "./types.js";

const addressParams = z.object({ campaign: z.string().min(32).max(44) });
const walletParams = z.object({
  wallet: z.string().refine((value) => {
    try {
      new PublicKey(value);
      return true;
    } catch {
      return false;
    }
  }),
});

export async function registerPublicRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  app.get(
    "/v1/fixtures",
    {
      schema: {
        tags: ["public"],
        response: {
          200: {
            type: "object",
            required: ["fixtures"],
            properties: {
              fixtures: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async () => {
      const result = await deps.pool.query<{
        fixture_id: string;
        home_name: string;
        away_name: string;
        competition_name: string;
        scheduled_start: Date;
        provider_status: string;
        campaign: string | null;
        campaign_state: string | null;
      }>(
        `SELECT f.fixture_id, f.home_name, f.away_name, f.competition_name, f.scheduled_start,
              f.provider_status, c.campaign, c.state AS campaign_state
       FROM fixture_catalog f LEFT JOIN campaign_projections c
         ON c.fixture_id = f.fixture_id AND c.state <> 'refunded'
       WHERE f.scheduled_start >= clock_timestamp() - interval '12 hours'
       ORDER BY f.scheduled_start LIMIT 100`,
      );
      return {
        fixtures: result.rows.map((row) => ({
          fixtureId: row.fixture_id,
          home: row.home_name,
          away: row.away_name,
          competition: row.competition_name,
          scheduledStart: row.scheduled_start.toISOString(),
          providerStatus: row.provider_status,
          fixtureSlotAvailable: row.campaign === null,
          campaign: row.campaign,
          campaignState: row.campaign_state,
        })),
      };
    },
  );

  app.get(
    "/v1/campaigns/:campaign",
    {
      schema: {
        tags: ["public"],
        params: {
          type: "object",
          required: ["campaign"],
          properties: { campaign: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { campaign } = addressParams.parse(request.params);
      const campaignResult = await deps.pool.query(
        `SELECT c.campaign, c.fixture_id, c.sponsor, c.state, c.reward_mint, c.refund_wallet,
              c.scheduled_start, c.registration_deadline, c.expected_end, c.hard_expiry, c.terminal_reason,
              c.required_funding::text, c.funded_amount::text, c.paid_amount::text,
              c.refunded_amount::text, c.external_inflow_total::text, c.registration_count,
              c.last_slot, c.commitment, c.updated_at, f.home_name, f.away_name, f.competition_name, f.provider_status
       FROM campaign_projections c LEFT JOIN fixture_catalog f ON f.fixture_id = c.fixture_id
       WHERE c.campaign = $1`,
        [campaign],
      );
      if (!campaignResult.rows[0]) return reply.notFound("campaign not found");
      const rounds = await deps.pool.query(
        `SELECT round, ordinal, source, encode(event_key, 'hex') AS event_key,
              opened_at, closes_at, reward_amount::text, winner_cap, winner_count,
              next_chain_sequence, skipped_count, paid_total::text, state, last_slot, commitment
       FROM round_projections WHERE campaign = $1 ORDER BY ordinal`,
        [campaign],
      );
      const configuredRounds = await deps.pool.query<{
        ordinal: number;
        reward_amount: string;
        winner_cap: number;
      }>(
        `SELECT ordinal, reward_amount::text, winner_cap FROM campaign_round_configs WHERE campaign = $1 ORDER BY ordinal`,
        [campaign],
      );
      return {
        campaign: toJson(campaignResult.rows[0]),
        rounds: rounds.rows.map(toJson),
        configuredRounds: configuredRounds.rows.map((round) => ({
          ordinal: round.ordinal,
          rewardAmount: round.reward_amount,
          winnerCap: round.winner_cap,
        })),
        explorer: `https://explorer.solana.com/address/${campaign}?cluster=devnet`,
      };
    },
  );

  app.get(
    "/v1/receipts/:receiptId",
    {
      schema: {
        tags: ["public"],
        params: {
          type: "object",
          required: ["receiptId"],
          properties: { receiptId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          required: ["cap"],
          properties: {
            cap: { type: "string", minLength: 20, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const params = z
        .object({ receiptId: z.string().uuid() })
        .parse(request.params);
      const query = z.object({ cap: z.string() }).parse(request.query);
      const secret = deps.config.RECEIPT_CAPABILITY_KEY;
      if (
        !secret ||
        !verifyReceiptCapability(query.cap, params.receiptId, secret)
      )
        return reply.unauthorized("invalid receipt capability");
      const result = await deps.pool.query<{
        receipt_id: string;
        campaign: string;
        round: string;
        wallet: string;
        sequence: string;
        status: string;
        transaction_signature: string | null;
        claim_pda: string | null;
        winner_rank: number | null;
        accepted_at: Date;
        canonical_payload: Buffer;
        receipt_signature: Buffer;
        authority_epoch: number;
        relayer_authority: Buffer;
      }>(
        `SELECT c.receipt_id, c.campaign, c.round, c.wallet, c.sequence, c.status,
              c.transaction_signature, c.claim_pda, c.winner_rank, c.accepted_at,
              r.canonical_payload, r.signature AS receipt_signature, r.authority_epoch, r.relayer_authority
       FROM claim_requests c JOIN receipts r USING (receipt_id) WHERE c.receipt_id = $1`,
        [params.receiptId],
      );
      const row = result.rows[0];
      if (!row) return reply.notFound("receipt not found");
      return {
        receiptId: row.receipt_id,
        campaign: row.campaign,
        round: row.round,
        wallet: row.wallet,
        sequence: row.sequence,
        status: row.status,
        acceptedAt: row.accepted_at.toISOString(),
        canonicalPayload: row.canonical_payload.toString("base64"),
        receiptSignature: row.receipt_signature.toString("base64"),
        authorityEpoch: row.authority_epoch,
        relayerAuthority: row.relayer_authority.toString("base64"),
        transactionSignature: row.transaction_signature,
        claimPda: row.claim_pda,
        winnerRank: row.winner_rank,
        explorer: row.transaction_signature
          ? `https://explorer.solana.com/tx/${row.transaction_signature}?cluster=devnet`
          : null,
      };
    },
  );

  app.get(
    "/v1/campaigns/:campaign/registrations/:wallet",
    {
      schema: {
        tags: ["public"],
        params: {
          type: "object",
          required: ["campaign", "wallet"],
          properties: {
            campaign: { type: "string", minLength: 32, maxLength: 44 },
            wallet: { type: "string", minLength: 32, maxLength: 44 },
          },
        },
      },
    },
    async (request) => {
      const params = addressParams.merge(walletParams).parse(request.params);
      const result = await deps.pool.query<{
        status: string;
        registration_pda: string | null;
        transaction_signature: string | null;
        registered_at: Date | null;
      }>(
        `SELECT status, registration_pda, transaction_signature, registered_at FROM (
         SELECT commitment AS status, registration_pda, transaction_signature, registered_at, 0 AS priority
           FROM registration_projections WHERE campaign = $1 AND wallet = $2
         UNION ALL
         SELECT status, registration_pda, transaction_signature, NULL::timestamptz AS registered_at, 1 AS priority
           FROM registration_requests WHERE campaign = $1 AND wallet = $2
       ) candidate ORDER BY priority LIMIT 1`,
        [params.campaign, params.wallet],
      );
      const row = result.rows[0];
      return {
        campaign: params.campaign,
        wallet: params.wallet,
        registered: row?.status === "confirmed" || row?.status === "finalized",
        status: row?.status ?? "not_registered",
        registrationPda: row?.registration_pda ?? null,
        transactionSignature: row?.transaction_signature ?? null,
        registeredAt: row?.registered_at?.toISOString() ?? null,
      };
    },
  );

  app.get(
    "/v1/wallets/:wallet/rewards",
    {
      schema: {
        tags: ["public"],
        params: {
          type: "object",
          required: ["wallet"],
          properties: {
            wallet: { type: "string", minLength: 32, maxLength: 44 },
          },
        },
      },
    },
    async (request) => {
      const { wallet } = walletParams.parse(request.params);
      const owner = new PublicKey(wallet);
      const mint = deps.onchain.rewardMint;
      const tokenAccount = getAssociatedTokenAddressSync(
        mint,
        owner,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const connection = new Connection(deps.config.SOLANA_HTTP_RPC_URL, {
        commitment: "confirmed",
        wsEndpoint: deps.config.SOLANA_WS_RPC_URL,
      });
      let balance = "0";
      try {
        balance = (
          await connection.getTokenAccountBalance(tokenAccount, "confirmed")
        ).value.amount;
      } catch {
        /* A missing ATA has zero balance. */
      }
      const claims = await deps.pool.query<{
        campaign: string;
        round: string;
        amount: string;
        winner_rank: number;
        transaction_signature: string;
        updated_at: Date;
      }>(
        `SELECT c.campaign, c.round, r.reward_amount::text AS amount, c.winner_rank, c.transaction_signature, c.updated_at
       FROM claim_requests c JOIN round_projections r ON r.round = c.round
       WHERE c.wallet = $1 AND c.status IN ('confirmed','finalized')
       ORDER BY c.updated_at DESC LIMIT 100`,
        [wallet],
      );
      return {
        wallet,
        mint: mint.toBase58(),
        tokenAccount: tokenAccount.toBase58(),
        balance,
        decimals: deps.onchain.rewardDecimals,
        claims: claims.rows.map((claim) => ({
          campaign: claim.campaign,
          round: claim.round,
          amount: claim.amount,
          winnerRank: claim.winner_rank,
          transactionSignature: claim.transaction_signature,
          confirmedAt: claim.updated_at.toISOString(),
          explorer: `https://explorer.solana.com/tx/${claim.transaction_signature}?cluster=devnet`,
        })),
      };
    },
  );

  app.get(
    "/v1/health/public",
    { schema: { tags: ["public"] } },
    async (_request, reply) => {
      try {
        await deps.pool.query("SELECT 1");
        return {
          status: "ok",
          network: "solana:devnet",
          demoMode: deps.config.DEMO_MODE_ENABLED,
          degraded: [],
        };
      } catch {
        reply.code(503);
        return {
          status: "degraded",
          network: "solana:devnet",
          demoMode: deps.config.DEMO_MODE_ENABLED,
          degraded: ["claim_service"],
        };
      }
    },
  );

  app.get(
    "/v1/campaigns/:campaign/events",
    {
      schema: {
        tags: ["public"],
        params: {
          type: "object",
          required: ["campaign"],
          properties: { campaign: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { after: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
    },
    async (request, reply) => {
      const { campaign } = addressParams.parse(request.params);
      const query = z
        .object({ after: z.string().regex(/^\d+$/).optional() })
        .parse(request.query);
      let cursor = BigInt(
        request.headers["last-event-id"]?.toString() ?? query.after ?? "0",
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const min = await deps.pool.query<{ min: string | null }>(
        "SELECT min(id)::text AS min FROM application_events WHERE campaign = $1",
        [campaign],
      );
      const minId = min.rows[0]?.min ? BigInt(min.rows[0].min) : null;
      if (cursor > 0n && minId !== null && cursor < minId - 1n) {
        reply.raw.write(
          `event: resnapshot\ndata: ${JSON.stringify({ campaign, reason: "replay_window_expired" })}\n\n`,
        );
        reply.raw.end();
        return;
      }
      let closed = false;
      request.raw.on("close", () => {
        closed = true;
      });
      let heartbeatAt = Date.now();
      while (!closed && !reply.raw.destroyed) {
        const events = await readApplicationEvents(
          deps.pool,
          campaign,
          cursor,
          100,
        );
        for (const event of events) {
          reply.raw.write(
            `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`,
          );
          cursor = event.id;
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          reply.raw.write(": heartbeat\n\n");
          heartbeatAt = Date.now();
        }
        await delay(events.length > 0 ? 100 : 750);
      }
    },
  );
}

function toJson(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? value.toISOString()
        : typeof value === "bigint"
          ? value.toString()
          : value,
    ]),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

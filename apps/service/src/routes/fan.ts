import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  acceptRegistration,
  claimRequestExists,
  issueChallenge,
  registrationRequestExists,
} from "@goaldrop/db";
import {
  DEVNET_NETWORK_DOMAIN,
  IntentAction,
  bytesFromHex,
  canonicalizeIntent,
  hex,
  intentHash,
} from "@goaldrop/protocol";
import { PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";
import { z } from "zod";
import { issueReceiptCapability } from "../capability.js";
import { ClaimAcceptanceBatcher } from "../claim-batcher.js";
import { decodeSecretBytes } from "../config.js";
import { requireWriteOrigin } from "../origin.js";
import { ensureFeePayerCapacity } from "../fee-payer-admission.js";
import type { RouteDependencies } from "./types.js";

const address = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "invalid Solana address");
const intentRequest = z.object({ campaign: address, wallet: address });
const claimIntentRequest = intentRequest.extend({ round: address });
const signedIntent = z.object({
  campaign: address,
  wallet: address,
  nonce: z.string().min(20).max(32),
  expiresAt: z.number().int().positive(),
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().min(80).max(100),
});
const signedClaim = signedIntent.extend({ round: address });
const burstRateLimit = { max: 600, timeWindow: "10 seconds" } as const;

export async function registerFanRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  const claimBatcher = new ClaimAcceptanceBatcher(deps.pool);
  const receiptSecret = decodeSecretBytes(
    deps.config.RELAYER_KEYPAIR ?? "",
    64,
    "RELAYER_KEYPAIR",
  );
  const receiptSigner = nacl.sign.keyPair.fromSecretKey(receiptSecret);
  if (!new PublicKey(receiptSigner.publicKey).equals(deps.onchain.relayer))
    throw new Error("receipt signer does not match on-chain relayer authority");
  const capabilitySecret = deps.config.RECEIPT_CAPABILITY_KEY;
  if (!capabilitySecret)
    throw new Error("receipt capability service unavailable");
  app.post(
    "/v1/intents/registration",
    { schema: writeSchema(["campaign", "wallet"]) },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const body = intentRequest.parse(request.body);
      const projection = await deps.pool.query<{ eligible: boolean }>(
        `SELECT state = 'active' AND terminal_reason = 'none' AND registration_deadline >= clock_timestamp()
              AND hard_expiry > clock_timestamp() AS eligible FROM campaign_projections WHERE campaign = $1`,
        [body.campaign],
      );
      if (!projection.rows[0]?.eligible)
        throw new Error("campaign is not open for registration");
      const challenge = await issueChallenge(deps.pool, {
        action: "register",
        ...body,
        origin,
      });
      return challengeResponse(
        deps,
        IntentAction.Register,
        body,
        undefined,
        challenge.nonce,
        challenge.expiresAt,
      );
    },
  );

  app.post(
    "/v1/intents/claim",
    {
      schema: writeSchema(["campaign", "round", "wallet"]),
      config: { rateLimit: burstRateLimit },
    },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const body = claimIntentRequest.parse(request.body);
      const projection = await deps.pool.query<{ eligible: boolean }>(
        `SELECT r.state = 'open' AND r.commitment IN ('confirmed', 'finalized') AND r.closes_at > clock_timestamp()
              AND r.winner_count < r.winner_cap AND EXISTS (
                SELECT 1 FROM registration_projections p WHERE p.campaign = r.campaign AND p.wallet = $3
                  AND p.commitment IN ('confirmed', 'finalized')
              ) AS eligible
       FROM round_projections r WHERE r.round = $1 AND r.campaign = $2`,
        [body.round, body.campaign, body.wallet],
      );
      if (!projection.rows[0]?.eligible)
        throw new Error("round is not open or fan is not registered");
      const challenge = await issueChallenge(deps.pool, {
        action: "claim",
        ...body,
        origin,
      });
      return challengeResponse(
        deps,
        IntentAction.Claim,
        body,
        body.round,
        challenge.nonce,
        challenge.expiresAt,
      );
    },
  );

  app.post(
    "/v1/registrations",
    { schema: signedSchema(false) },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const body = signedIntent.parse(request.body);
      const verified = verifySubmittedIntent(
        deps,
        IntentAction.Register,
        body,
        undefined,
      );
      if (
        !(await registrationRequestExists(
          deps.pool,
          body.campaign,
          body.wallet,
        ))
      )
        await ensureFeePayerCapacity(deps.config);
      const result = await acceptRegistration(deps.pool, {
        campaign: body.campaign,
        wallet: body.wallet,
        intentHash: verified.hash,
        fanSignature: verified.signature,
        nonce: verified.nonce,
        expiresAt: new Date(body.expiresAt * 1_000),
        origin,
        traceId: request.id,
      });
      return {
        registrationId: result.id,
        campaign: result.campaign,
        wallet: result.wallet,
        status: result.status,
        duplicate: result.duplicate,
        acceptedAt: result.acceptedAt.toISOString(),
      };
    },
  );

  app.post(
    "/v1/claims",
    {
      schema: signedSchema(true),
      config: { rateLimit: burstRateLimit },
    },
    async (request) => {
      const origin = requireWriteOrigin(request, deps.config);
      const body = signedClaim.parse(request.body);
      const verified = verifySubmittedIntent(
        deps,
        IntentAction.Claim,
        body,
        body.round,
      );
      if (!(await claimRequestExists(deps.pool, body.round, body.wallet)))
        await ensureFeePayerCapacity(deps.config);
      const result = await claimBatcher.accept({
        campaign: body.campaign,
        round: body.round,
        wallet: body.wallet,
        recipient: body.wallet,
        programId: deps.config.GOALDROP_PROGRAM_ID,
        intentHash: verified.hash,
        fanSignature: verified.signature,
        nonce: verified.nonce,
        expiresAt: new Date(body.expiresAt * 1_000),
        origin,
        authorityEpoch: deps.onchain.authorityEpoch,
        relayerPublicKey: receiptSigner.publicKey,
        relayerSecretKey: receiptSigner.secretKey,
        traceId: request.id,
      });
      return {
        receiptId: result.receiptId,
        sequence: result.sequence.toString(),
        acceptedAt: result.acceptedAt.toISOString(),
        status: result.status,
        duplicate: result.duplicate,
        canonicalPayload: Buffer.from(result.canonicalPayload).toString(
          "base64",
        ),
        receiptSignature: Buffer.from(result.receiptSignature).toString(
          "base64",
        ),
        capability: issueReceiptCapability(result.receiptId, capabilitySecret),
      };
    },
  );
}

function challengeResponse(
  deps: RouteDependencies,
  action: 1 | 2,
  body: { campaign: string; wallet: string },
  round: string | undefined,
  nonce: Uint8Array,
  expiresAt: Date,
) {
  const fields = canonicalizeIntent({
    programId: deps.config.GOALDROP_PROGRAM_ID,
    action,
    campaign: body.campaign,
    round,
    wallet: body.wallet,
    nonce,
    expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1_000)),
  });
  return {
    version: 1,
    action: action === IntentAction.Register ? "register" : "claim",
    networkDomain: hex(DEVNET_NETWORK_DOMAIN),
    programId: deps.config.GOALDROP_PROGRAM_ID,
    campaign: body.campaign,
    round: round ?? null,
    wallet: body.wallet,
    recipient: body.wallet,
    nonce: Buffer.from(nonce).toString("base64url"),
    expiresAt: Number(fields.expiresAt),
    intentHash: hex(intentHash(fields)),
    preview:
      action === IntentAction.Register
        ? `Register ${body.wallet.slice(0, 4)}…${body.wallet.slice(-4)} for GoalDrop on Solana Devnet`
        : `Claim this GoalDrop round to ${body.wallet.slice(0, 4)}…${body.wallet.slice(-4)} on Solana Devnet`,
  };
}

function verifySubmittedIntent(
  deps: RouteDependencies,
  action: 1 | 2,
  body: z.infer<typeof signedIntent>,
  round: string | undefined,
): { hash: Uint8Array; signature: Uint8Array; nonce: Uint8Array } {
  const nonce = decodeBase64(body.nonce, 16, "nonce", true);
  const signature = decodeBase64(body.signature, 64, "signature", false);
  const fields = canonicalizeIntent({
    programId: deps.config.GOALDROP_PROGRAM_ID,
    action,
    campaign: body.campaign,
    round,
    wallet: body.wallet,
    nonce,
    expiresAt: BigInt(body.expiresAt),
  });
  const hash = intentHash(fields);
  if (!Buffer.from(hash).equals(Buffer.from(bytesFromHex(body.intentHash, 32))))
    throw new Error("intent hash does not match canonical fields");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(fields.wallet),
  ]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  if (!verifyEd25519(null, hash, publicKey, signature))
    throw new Error("fan signature is invalid");
  return { hash, signature, nonce };
}

function decodeBase64(
  value: string,
  length: number,
  field: string,
  url: boolean,
): Uint8Array {
  const bytes = Buffer.from(value, url ? "base64url" : "base64");
  if (bytes.length !== length)
    throw new Error(`${field} must contain ${length} bytes`);
  return new Uint8Array(bytes);
}

function writeSchema(required: string[]) {
  return {
    tags: ["fan"],
    body: {
      type: "object",
      additionalProperties: false,
      required,
      properties: Object.fromEntries(
        required.map((key) => [
          key,
          { type: "string", minLength: 1, maxLength: 100 },
        ]),
      ),
    },
  };
}

function signedSchema(claim: boolean) {
  return {
    tags: ["fan"],
    body: {
      type: "object",
      additionalProperties: false,
      required: claim
        ? [
            "campaign",
            "round",
            "wallet",
            "nonce",
            "expiresAt",
            "intentHash",
            "signature",
          ]
        : [
            "campaign",
            "wallet",
            "nonce",
            "expiresAt",
            "intentHash",
            "signature",
          ],
      properties: {
        campaign: { type: "string", maxLength: 44 },
        round: { type: "string", maxLength: 44 },
        wallet: { type: "string", maxLength: 44 },
        nonce: { type: "string", maxLength: 32 },
        expiresAt: { type: "integer" },
        intentHash: { type: "string", minLength: 64, maxLength: 64 },
        signature: { type: "string", maxLength: 100 },
      },
    },
  };
}

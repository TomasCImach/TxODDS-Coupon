import { randomUUID } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildSponsoredV0Transaction,
  campaignPda,
  configPda,
  createCampaignInstruction,
  decodeCampaignAccount,
  deserializeSponsoredTransaction,
  fixtureSlotPda,
  fundCampaignInstruction,
  refundCampaignInstruction,
  sponsorCampaignInstruction,
  validateSignedTemplate,
  vaultPda,
} from "@goaldrop/solana-client";
import { CampaignState } from "@goaldrop/protocol";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWriteOrigin } from "../origin.js";
import { ensureFeePayerCapacity } from "../fee-payer-admission.js";
import { keypairFromConfig } from "../workers/solana.js";
import type { RouteDependencies } from "./types.js";

const address = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "invalid Solana address");
const integer = z.string().regex(/^\d+$/).transform(BigInt);
const positiveInteger = integer.refine((value) => value > 0n);
const createRequest = z.object({
  sponsor: address,
  refundWallet: address,
  fixtureId: positiveInteger,
  campaignNonce: integer,
  scheduledStart: z.number().int().positive(),
  registrationDeadline: z.number().int().positive(),
  expectedEnd: z.number().int().positive(),
  hardExpiry: z.number().int().positive(),
  rounds: z
    .array(
      z.object({
        rewardAmount: positiveInteger,
        winnerCap: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(8),
});
const campaignRequest = z.object({ sponsor: address, campaign: address });
const fundRequest = campaignRequest.extend({ sourceTokenAccount: address });
const refundRequest = z.object({ campaign: address });
const transferRequest = z.object({
  wallet: address,
  destination: address,
  amount: positiveInteger,
});
const submitRequest = z.object({
  templateId: z.string().uuid(),
  signedTransaction: z.string().min(100).max(5_000),
});

type Action = "create" | "fund" | "activate" | "cancel" | "refund" | "transfer";

interface TemplateRow {
  id: string;
  action: Action;
  actor: string | null;
  fee_payer: string;
  message_bytes: Buffer;
  allowed_program_ids: string[];
  metadata: Record<string, unknown>;
  status: string;
  transaction_signature: string | null;
  expires_at: Date;
}

export async function registerTransactionRoutes(
  app: FastifyInstance,
  deps: RouteDependencies,
): Promise<void> {
  app.post(
    "/v1/sponsor/transactions/:action",
    {
      schema: {
        tags: ["sponsor"],
        params: {
          type: "object",
          required: ["action"],
          properties: {
            action: {
              enum: ["create", "fund", "activate", "cancel", "refund"],
            },
          },
        },
        body: { type: "object", additionalProperties: true },
      },
    },
    async (request) => {
      requireWriteOrigin(request, deps.config);
      const action = z
        .object({
          action: z.enum(["create", "fund", "activate", "cancel", "refund"]),
        })
        .parse(request.params).action;
      return buildSponsorTemplate(deps, action, request.body, request.id);
    },
  );

  app.post(
    "/v1/sponsor/transactions/submit",
    { schema: submitSchema("sponsor") },
    async (request) => {
      requireWriteOrigin(request, deps.config);
      return submitTemplate(deps, submitRequest.parse(request.body), [
        "create",
        "fund",
        "activate",
        "cancel",
        "refund",
      ]);
    },
  );

  app.post(
    "/v1/transfers/build",
    {
      schema: {
        tags: ["fan"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["wallet", "destination", "amount"],
          properties: {
            wallet: { type: "string", maxLength: 44 },
            destination: { type: "string", maxLength: 44 },
            amount: { type: "string", pattern: "^[0-9]+$", maxLength: 20 },
          },
        },
      },
    },
    async (request) => {
      requireWriteOrigin(request, deps.config);
      return buildTransferTemplate(
        deps,
        transferRequest.parse(request.body),
        request.id,
      );
    },
  );

  app.post(
    "/v1/transfers/submit",
    { schema: submitSchema("fan") },
    async (request) => {
      requireWriteOrigin(request, deps.config);
      return submitTemplate(deps, submitRequest.parse(request.body), [
        "transfer",
      ]);
    },
  );
}

async function buildSponsorTemplate(
  deps: RouteDependencies,
  action: Exclude<Action, "transfer">,
  body: unknown,
  traceId: string,
) {
  const context = transactionContext(deps);
  if (action === "create") {
    const input = createRequest.parse(body);
    validateTimes(input);
    const sponsor = new PublicKey(input.sponsor);
    const refundWallet = new PublicKey(input.refundWallet);
    const [campaign] = campaignPda(
      context.programId,
      sponsor,
      input.campaignNonce,
    );
    const [fixtureSlot] = fixtureSlotPda(context.programId, input.fixtureId);
    const [vault] = vaultPda(context.programId, campaign);
    const requiredFunding = input.rounds.reduce(
      (total, round) => total + round.rewardAmount * BigInt(round.winnerCap),
      0n,
    );
    assertU64(requiredFunding, "required funding");
    const instruction = createCampaignInstruction(
      context.programId,
      {
        config: context.config,
        sponsor,
        feePayer: context.feePayer.publicKey,
        refundWallet,
        rewardMint: context.rewardMint,
        fixtureSlot,
        campaign,
        vault,
      },
      {
        fixtureId: input.fixtureId,
        campaignNonce: input.campaignNonce,
        scheduledStart: BigInt(input.scheduledStart),
        registrationDeadline: BigInt(input.registrationDeadline),
        expectedEnd: BigInt(input.expectedEnd),
        hardExpiry: BigInt(input.hardExpiry),
        rounds: input.rounds,
      },
    );
    return issueTemplate(deps, context.connection, {
      action,
      actor: sponsor,
      instructions: [instruction],
      traceId,
      metadata: {
        campaign: campaign.toBase58(),
        fixtureSlot: fixtureSlot.toBase58(),
        vault: vault.toBase58(),
        sponsor: sponsor.toBase58(),
        requiredFunding: requiredFunding.toString(),
        fixtureId: input.fixtureId.toString(),
      },
    });
  }

  if (action === "refund") {
    const input = refundRequest.parse(body);
    const campaignAddress = new PublicKey(input.campaign);
    const campaign = await readCampaign(
      context.connection,
      context.programId,
      campaignAddress,
    );
    if (campaign.state !== CampaignState.Refundable)
      throw new Error("campaign is not refundable");
    const [vault] = vaultPda(context.programId, campaignAddress);
    const refundToken = getAssociatedTokenAddressSync(
      context.rewardMint,
      campaign.refundWallet,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const instructions = [
      createAssociatedTokenAccountIdempotentInstruction(
        context.feePayer.publicKey,
        refundToken,
        campaign.refundWallet,
        context.rewardMint,
      ),
      refundCampaignInstruction(context.programId, {
        campaign: campaignAddress,
        vault,
        rewardMint: context.rewardMint,
        refundWallet: campaign.refundWallet,
        refundToken,
      }),
    ];
    return issueTemplate(deps, context.connection, {
      action,
      actor: null,
      instructions,
      traceId,
      metadata: {
        campaign: input.campaign,
        refundWallet: campaign.refundWallet.toBase58(),
        refundToken: refundToken.toBase58(),
        vault: vault.toBase58(),
      },
    });
  }

  const input = (action === "fund" ? fundRequest : campaignRequest).parse(body);
  const sponsor = new PublicKey(input.sponsor);
  const campaignAddress = new PublicKey(input.campaign);
  const campaign = await readCampaign(
    context.connection,
    context.programId,
    campaignAddress,
  );
  if (!campaign.sponsor.equals(sponsor))
    throw new Error("sponsor does not control campaign");
  const [derived] = campaignPda(
    context.programId,
    sponsor,
    campaign.campaignNonce,
  );
  if (!derived.equals(campaignAddress))
    throw new Error("campaign PDA is invalid");
  const [vault] = vaultPda(context.programId, campaignAddress);
  let instruction: TransactionInstruction;
  if (action === "fund") {
    if (campaign.state !== CampaignState.Draft)
      throw new Error("campaign is not in draft state");
    const sourceTokenAccount = new PublicKey(
      (input as z.infer<typeof fundRequest>).sourceTokenAccount,
    );
    const source = await getAccount(
      context.connection,
      sourceTokenAccount,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (
      !source.owner.equals(sponsor) ||
      !source.mint.equals(context.rewardMint)
    )
      throw new Error("source token account has wrong owner or mint");
    if (source.amount < campaign.requiredFunding)
      throw new Error("source token balance is below required funding");
    instruction = fundCampaignInstruction(
      context.programId,
      {
        config: context.config,
        sponsor,
        campaign: campaignAddress,
        sponsorSource: sourceTokenAccount,
        rewardMint: context.rewardMint,
        vault,
      },
      campaign.requiredFunding,
    );
  } else {
    const validState =
      action === "activate"
        ? campaign.state === CampaignState.Funded
        : campaign.state === CampaignState.Draft ||
          campaign.state === CampaignState.Funded;
    if (!validState)
      throw new Error(`campaign cannot ${action} from its current state`);
    instruction = sponsorCampaignInstruction(
      context.programId,
      action === "activate" ? "activate_campaign" : "cancel_campaign",
      {
        config: context.config,
        sponsor,
        campaign: campaignAddress,
        vault,
      },
    );
  }
  return issueTemplate(deps, context.connection, {
    action,
    actor: sponsor,
    instructions: [instruction],
    traceId,
    metadata: {
      campaign: campaignAddress.toBase58(),
      sponsor: sponsor.toBase58(),
      vault: vault.toBase58(),
      requiredFunding: campaign.requiredFunding.toString(),
    },
  });
}

async function buildTransferTemplate(
  deps: RouteDependencies,
  input: z.infer<typeof transferRequest>,
  traceId: string,
) {
  const context = transactionContext(deps);
  const wallet = new PublicKey(input.wallet);
  const destination = new PublicKey(input.destination);
  if (wallet.equals(destination))
    throw new Error("transfer destination must differ from sender");
  const source = getAssociatedTokenAddressSync(
    context.rewardMint,
    wallet,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destinationToken = getAssociatedTokenAddressSync(
    context.rewardMint,
    destination,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const sourceAccount = await getAccount(
    context.connection,
    source,
    "confirmed",
    TOKEN_PROGRAM_ID,
  );
  if (
    !sourceAccount.owner.equals(wallet) ||
    !sourceAccount.mint.equals(context.rewardMint)
  )
    throw new Error("source is not the wallet's canonical reward account");
  if (sourceAccount.amount < input.amount)
    throw new Error("reward token balance is insufficient");
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      context.feePayer.publicKey,
      destinationToken,
      destination,
      context.rewardMint,
    ),
    createTransferCheckedInstruction(
      source,
      context.rewardMint,
      destinationToken,
      wallet,
      input.amount,
      deps.onchain.rewardDecimals ?? 6,
    ),
  ];
  return issueTemplate(deps, context.connection, {
    action: "transfer",
    actor: wallet,
    instructions,
    traceId,
    metadata: {
      wallet: wallet.toBase58(),
      source: source.toBase58(),
      destination: destination.toBase58(),
      destinationToken: destinationToken.toBase58(),
      mint: context.rewardMint.toBase58(),
      amount: input.amount.toString(),
      decimals: deps.onchain.rewardDecimals ?? 6,
    },
  });
}

async function issueTemplate(
  deps: RouteDependencies,
  connection: Connection,
  input: {
    action: Action;
    actor: PublicKey | null;
    instructions: readonly TransactionInstruction[];
    metadata: Record<string, unknown>;
    traceId: string;
  },
) {
  await ensureFeePayerCapacity(deps.config);
  const feePayer = keypairFromConfig(
    deps.config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash,
    instructions: input.instructions,
    compute: {
      units: input.action === "create" ? 350_000 : 220_000,
      microLamports: 1_000,
    },
  });
  const serialized = transaction.serialize();
  if (serialized.length > 1_232)
    throw new Error("transaction template exceeds Solana size limit");
  const allowedPrograms = [
    ...new Set(
      [
        ComputeBudgetProgram.programId,
        ...input.instructions.map((instruction) => instruction.programId),
      ].map((key) => key.toBase58()),
    ),
  ];
  const metadata = {
    ...input.metadata,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
  const expiresAt = new Date(Date.now() + 75_000);
  const created = await deps.pool.query<{ id: string }>(
    `INSERT INTO sponsored_transaction_templates (
       action, actor, fee_payer, message_bytes, allowed_program_ids, metadata, expires_at, trace_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
    [
      input.action,
      input.actor?.toBase58() ?? null,
      feePayer.publicKey.toBase58(),
      transaction.message.serialize(),
      allowedPrograms,
      JSON.stringify(metadata),
      expiresAt,
      input.traceId,
    ],
  );
  return {
    templateId: created.rows[0]?.id,
    action: input.action,
    transaction: Buffer.from(serialized).toString("base64"),
    expiresAt: expiresAt.toISOString(),
    network: "solana:devnet",
    feePayer: feePayer.publicKey.toBase58(),
    ...input.metadata,
  };
}

async function submitTemplate(
  deps: RouteDependencies,
  input: z.infer<typeof submitRequest>,
  actions: readonly Action[],
) {
  const result = await deps.pool.query<TemplateRow>(
    `SELECT id, action, actor, fee_payer, message_bytes, allowed_program_ids, metadata,
            status, transaction_signature, expires_at
     FROM sponsored_transaction_templates WHERE id = $1`,
    [input.templateId],
  );
  const row = result.rows[0];
  if (!row || !actions.includes(row.action))
    throw new Error("transaction template not found");
  const connection = transactionContext(deps).connection;
  if (row.status === "submitted" && row.transaction_signature) {
    await reconcileRefundProjection(deps, connection, row).catch(
      () => undefined,
    );
    return submittedTemplate(row, true);
  }
  if (["submitting", "ambiguous"].includes(row.status)) {
    if (!row.transaction_signature)
      throw new Error(
        `transaction template is ${row.status} with no recoverable signature`,
      );
    const recovered = await connection.getSignatureStatuses(
      [row.transaction_signature],
      { searchTransactionHistory: true },
    );
    const status = recovered.value[0];
    if (status?.err) {
      await deps.pool.query(
        `UPDATE sponsored_transaction_templates SET status = 'failed', error_detail = $2,
                updated_at = clock_timestamp() WHERE id = $1`,
        [row.id, JSON.stringify(status.err).slice(0, 500)],
      );
      throw new Error("submitted transaction failed on chain");
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      await deps.pool.query(
        `UPDATE sponsored_transaction_templates SET status = 'submitted', submitted_at = COALESCE(submitted_at, clock_timestamp()),
                updated_at = clock_timestamp() WHERE id = $1`,
        [row.id],
      );
      await reconcileRefundProjection(deps, connection, row).catch(
        () => undefined,
      );
      return submittedTemplate(row, true);
    }
    throw new Error(
      `transaction submission is still ambiguous: ${row.transaction_signature}`,
    );
  }
  if (row.status !== "built")
    throw new Error(`transaction template is ${row.status}`);
  const feePayer = keypairFromConfig(
    deps.config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  if (!feePayer.publicKey.equals(new PublicKey(row.fee_payer)))
    throw new Error("template fee payer is no longer active");
  let transaction: VersionedTransaction;
  try {
    transaction = deserializeSponsoredTransaction(
      Buffer.from(input.signedTransaction, "base64"),
    );
  } catch {
    throw new Error("signed transaction is malformed");
  }
  validateSignedTemplate(transaction, {
    feePayer: feePayer.publicKey,
    allowedProgramIds: row.allowed_program_ids.map(
      (program) => new PublicKey(program),
    ),
    ...(row.actor ? { requiredSigner: new PublicKey(row.actor) } : {}),
    templateMessageBytes: row.message_bytes,
    expiresAt: row.expires_at,
  });
  const claimed = await deps.pool.query(
    `UPDATE sponsored_transaction_templates SET status = 'submitting', updated_at = clock_timestamp()
     WHERE id = $1 AND status = 'built' AND expires_at >= clock_timestamp() RETURNING id`,
    [row.id],
  );
  if (!claimed.rowCount)
    throw new Error("transaction template is already used or expired");
  transaction.sign([feePayer]);
  let sendAttempted = false;
  let submittedSignature: string | null = null;
  try {
    const simulation = await connection.simulateTransaction(transaction, {
      commitment: "confirmed",
      sigVerify: true,
    });
    if (simulation.value.err)
      throw new Error(
        `transaction simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    sendAttempted = true;
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { maxRetries: 2, skipPreflight: true },
    );
    submittedSignature = signature;
    await deps.pool.query(
      `UPDATE sponsored_transaction_templates SET transaction_signature = $2,
              submitted_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
      [row.id, signature],
    );
    const blockhash = String(row.metadata.blockhash);
    const lastValidBlockHeight = Number(row.metadata.lastValidBlockHeight);
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err)
      throw new Error(
        `transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    await deps.pool.query(
      `UPDATE sponsored_transaction_templates SET status = 'submitted', transaction_signature = $2,
              submitted_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1`,
      [row.id, signature],
    );
    await reconcileRefundProjection(deps, connection, row).catch(
      () => undefined,
    );
    return {
      templateId: row.id,
      action: row.action,
      signature,
      duplicate: false,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      ...row.metadata,
    };
  } catch (error) {
    await deps.pool.query(
      `UPDATE sponsored_transaction_templates SET status = $2,
              transaction_signature = COALESCE(transaction_signature, $3),
              error_detail = left($4,500), updated_at = clock_timestamp() WHERE id = $1`,
      [
        row.id,
        sendAttempted ? "ambiguous" : "failed",
        submittedSignature,
        error instanceof Error ? error.message : "submission failed",
      ],
    );
    throw error;
  }
}

async function reconcileRefundProjection(
  deps: RouteDependencies,
  connection: Connection,
  row: TemplateRow,
): Promise<void> {
  if (row.action !== "refund") return;
  const campaignValue = row.metadata.campaign;
  if (typeof campaignValue !== "string") return;
  const campaignAddress = new PublicKey(campaignValue);
  const programId = new PublicKey(deps.config.GOALDROP_PROGRAM_ID);
  const info = await connection.getAccountInfo(campaignAddress, "confirmed");
  if (!info || !info.owner.equals(programId) || info.data.length !== 424)
    throw new Error("campaign readback failed after refund");
  const campaign = decodeCampaignAccount(info.data);
  if (campaign.state !== CampaignState.Refunded)
    throw new Error("campaign did not enter Refunded state");
  const slot = await connection.getSlot("confirmed");
  await deps.pool.query(
    `UPDATE campaign_projections SET state = 'refunded', funded_amount = $2,
       paid_amount = $3, refunded_amount = $4, external_inflow_total = $5,
       last_slot = $6, commitment = 'confirmed', updated_at = clock_timestamp()
     WHERE campaign = $1`,
    [
      campaignAddress.toBase58(),
      campaign.fundedAmount.toString(),
      campaign.paidAmount.toString(),
      campaign.refundedAmount.toString(),
      campaign.externalInflowTotal.toString(),
      slot,
    ],
  );
}

function submittedTemplate(row: TemplateRow, duplicate: boolean) {
  const signature = row.transaction_signature;
  if (!signature)
    throw new Error("submitted transaction is missing its signature");
  return {
    templateId: row.id,
    action: row.action,
    signature,
    duplicate,
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    ...row.metadata,
  };
}

function transactionContext(deps: RouteDependencies) {
  const feePayer = keypairFromConfig(
    deps.config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  const programId = new PublicKey(deps.config.GOALDROP_PROGRAM_ID);
  const rewardMint = new PublicKey(deps.config.GOALDROP_REWARD_MINT);
  if (!rewardMint.equals(deps.onchain.rewardMint))
    throw new Error("configured reward mint does not match PlatformConfig");
  return {
    feePayer,
    programId,
    rewardMint,
    config: configPda(programId)[0],
    connection: new Connection(deps.config.SOLANA_HTTP_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: deps.config.SOLANA_WS_RPC_URL,
    }),
  };
}

async function readCampaign(
  connection: Connection,
  programId: PublicKey,
  addressValue: PublicKey,
) {
  const account = await connection.getAccountInfo(addressValue, "confirmed");
  if (!account || !account.owner.equals(programId))
    throw new Error("campaign account not found");
  return decodeCampaignAccount(account.data);
}

function validateTimes(input: z.infer<typeof createRequest>): void {
  const now = Math.floor(Date.now() / 1_000);
  if (!(
    now < input.registrationDeadline &&
    input.registrationDeadline <= input.scheduledStart &&
    input.scheduledStart < input.expectedEnd &&
    input.expectedEnd < input.hardExpiry &&
    input.hardExpiry <= input.scheduledStart + 28_800
  ))
    throw new Error("campaign time bounds are invalid");
}

function assertU64(value: bigint, field: string): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error(`${field} exceeds u64`);
}

function submitSchema(tag: string) {
  return {
    tags: [tag],
    body: {
      type: "object",
      additionalProperties: false,
      required: ["templateId", "signedTransaction"],
      properties: {
        templateId: { type: "string", format: "uuid" },
        signedTransaction: { type: "string", minLength: 100, maxLength: 5_000 },
      },
    },
  };
}

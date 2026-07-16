import { randomUUID } from "node:crypto";
import type { DatabasePool } from "@goaldrop/db";
import {
  buildSponsoredV0Transaction,
  decodeGoalReceiptAccount,
  type CampaignAccount,
  type ComputeBudget,
} from "@goaldrop/solana-client";
import {
  Connection,
  Keypair,
  type AccountInfo,
  type PublicKey,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { decodeSecretBytes, type ServiceConfig } from "../config.js";

class ConfirmedTransactionFailure extends Error {}

export function connectionFor(config: ServiceConfig): Connection {
  return new Connection(config.SOLANA_HTTP_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: config.SOLANA_WS_RPC_URL,
    confirmTransactionInitialTimeout: 20_000,
  });
}

export function keypairFromConfig(
  value: string | undefined,
  name: string,
): Keypair {
  return Keypair.fromSecretKey(decodeSecretBytes(value ?? "", 64, name));
}

export function resolveGoalRound(input: {
  programId: PublicKey;
  campaignAddress: PublicKey;
  campaign: CampaignAccount;
  eventHash: Uint8Array;
  expectedSource: number;
  receiptInfo: AccountInfo<Buffer> | null;
}): { ordinal: number; alreadyOpened: boolean } | null {
  if (!input.receiptInfo) {
    if (input.campaign.nextRound >= input.campaign.roundCount) return null;
    return { ordinal: input.campaign.nextRound, alreadyOpened: false };
  }
  if (!input.receiptInfo.owner.equals(input.programId))
    throw new Error("goal receipt has wrong owner");
  const receipt = decodeGoalReceiptAccount(input.receiptInfo.data);
  if (
    !receipt.campaign.equals(input.campaignAddress) ||
    !Buffer.from(receipt.eventHash).equals(Buffer.from(input.eventHash)) ||
    receipt.source !== input.expectedSource ||
    receipt.roundOrdinal >= input.campaign.roundCount
  )
    throw new Error("goal receipt does not match the requested round");
  return { ordinal: receipt.roundOrdinal, alreadyOpened: true };
}

export async function sendWorkerTransaction(input: {
  config: ServiceConfig;
  pool: DatabasePool;
  connection: Connection;
  purpose: string;
  aggregateKey: string;
  instructions: readonly TransactionInstruction[];
  feePayer: Keypair;
  authority?: Keypair;
  compute: ComputeBudget;
  traceId?: string;
}): Promise<{ signature: string; slot: number }> {
  const traceId = input.traceId ?? randomUUID();
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: input.feePayer.publicKey,
    blockhash,
    instructions: input.instructions,
    compute: input.compute,
  });
  const signers =
    input.authority &&
    !input.authority.publicKey.equals(input.feePayer.publicKey)
      ? [input.feePayer, input.authority]
      : [input.feePayer];
  transaction.sign(signers);
  const expectedSignature = bs58.encode(transaction.signatures[0]!);
  const simulated = await input.connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulated.value.err)
    throw new Error(
      `transaction simulation failed: ${JSON.stringify(simulated.value.err)}`,
    );
  const record = await input.pool.query<{ id: string }>(
    `INSERT INTO chain_transactions (
       purpose, aggregate_key, signature, blockhash, last_valid_block_height, accounts, status, trace_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'built',$7) RETURNING id::text`,
    [
      input.purpose,
      input.aggregateKey,
      expectedSignature,
      blockhash.blockhash,
      blockhash.lastValidBlockHeight,
      JSON.stringify(accountKeys(input.instructions)),
      traceId,
    ],
  );
  const id = record.rows[0]?.id;
  try {
    const signature = await input.connection.sendRawTransaction(
      transaction.serialize(),
      { maxRetries: 0, skipPreflight: true },
    );
    if (signature !== expectedSignature)
      throw new Error("RPC returned an unexpected transaction signature");
    await input.pool.query(
      "UPDATE chain_transactions SET status = 'submitted', submitted_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
      [id],
    );
    const confirmation = await input.connection.confirmTransaction(
      { signature, ...blockhash },
      "confirmed",
    );
    if (confirmation.value.err)
      throw new ConfirmedTransactionFailure(
        `transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    await input.pool.query(
      "UPDATE chain_transactions SET status = 'confirmed', confirmed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1",
      [id],
    );
    return { signature, slot: confirmation.context.slot };
  } catch (error) {
    const status =
      error instanceof ConfirmedTransactionFailure ? "failed" : "ambiguous";
    await input.pool.query(
      "UPDATE chain_transactions SET status = $2, error_detail = left($3,500), updated_at = clock_timestamp() WHERE id = $1",
      [
        id,
        status,
        error instanceof Error ? error.message : "unknown submission error",
      ],
    );
    throw error;
  }
}

export async function waitForAccount(
  connection: Connection,
  address: PublicKey,
  attempts = 8,
): Promise<Buffer | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const account = await connection.getAccountInfo(address, "confirmed");
    if (account) return account.data;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

export function tokenDelta(
  transaction: VersionedTransactionResponse,
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): bigint | null {
  const keys =
    transaction.transaction.message.getAccountKeys().staticAccountKeys;
  const index = keys.findIndex((key) => key.equals(account));
  if (index < 0 || !transaction.meta) return null;
  const pre = transaction.meta.preTokenBalances?.find(
    (balance) => balance.accountIndex === index,
  );
  const post = transaction.meta.postTokenBalances?.find(
    (balance) => balance.accountIndex === index,
  );
  if (!post || post.mint !== mint.toBase58() || post.owner !== owner.toBase58())
    return null;
  return (
    BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0")
  );
}

function accountKeys(
  instructions: readonly TransactionInstruction[],
): string[] {
  return [
    ...new Set(
      instructions.flatMap((ix) => [
        ix.programId.toBase58(),
        ...ix.keys.map((key) => key.pubkey.toBase58()),
      ]),
    ),
  ];
}

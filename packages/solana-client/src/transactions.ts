import {
  ComputeBudgetProgram,
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

export interface ComputeBudget {
  units: number;
  microLamports: number;
}

export const DEFAULT_CLAIM_COMPUTE: ComputeBudget = {
  units: 260_000,
  microLamports: 1_000,
};

export function fanSignatureVerificationInstruction(
  wallet: PublicKey,
  intentHash: Uint8Array,
  signature: Uint8Array,
): TransactionInstruction {
  if (intentHash.length !== 32)
    throw new RangeError("intent hash must be 32 bytes");
  if (signature.length !== 64)
    throw new RangeError("Ed25519 signature must be 64 bytes");
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: wallet.toBytes(),
    message: intentHash,
    signature,
  });
}

export function buildSponsoredV0Transaction(input: {
  feePayer: PublicKey;
  blockhash: BlockhashWithExpiryBlockHeight;
  instructions: readonly TransactionInstruction[];
  compute?: ComputeBudget;
}): VersionedTransaction {
  const instructions = input.compute
    ? [
        ComputeBudgetProgram.setComputeUnitLimit({
          units: input.compute.units,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: input.compute.microLamports,
        }),
        ...input.instructions,
      ]
    : [...input.instructions];
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash: input.blockhash.blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function assertTransactionSize(
  transaction: VersionedTransaction,
  maximum = 1_232,
): number {
  const size = transaction.serialize().length;
  if (size > maximum)
    throw new Error(`transaction is ${size} bytes; maximum is ${maximum}`);
  return size;
}

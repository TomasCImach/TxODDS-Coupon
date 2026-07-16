import {
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

export interface SponsoredTemplatePolicy {
  feePayer: PublicKey;
  allowedProgramIds: readonly PublicKey[];
  requiredSigner?: PublicKey;
  templateMessageBytes: Uint8Array;
  expiresAt: Date;
}

export function validateSignedTemplate(
  transaction: VersionedTransaction,
  policy: SponsoredTemplatePolicy,
): void {
  if (policy.expiresAt.getTime() < Date.now())
    throw new Error("sponsored transaction template expired");
  const actual = transaction.message.serialize();
  if (!Buffer.from(actual).equals(Buffer.from(policy.templateMessageBytes))) {
    throw new Error("signed transaction message differs from issued template");
  }
  const keys = transaction.message.getAccountKeys().staticAccountKeys;
  if (!keys[0]?.equals(policy.feePayer))
    throw new Error("unexpected fee payer");
  if (policy.requiredSigner) {
    const requiredSigner = policy.requiredSigner;
    const signerIndex = keys.findIndex((key) => key.equals(requiredSigner));
    if (
      signerIndex < 0 ||
      signerIndex >= transaction.message.header.numRequiredSignatures
    ) {
      throw new Error("required sponsor/fan signer is absent");
    }
    const signature = transaction.signatures[signerIndex];
    if (
      !signature ||
      !nacl.sign.detached.verify(actual, signature, requiredSigner.toBytes())
    ) {
      throw new Error("required sponsor/fan signature is invalid");
    }
  }
  const allowed = new Set(
    policy.allowedProgramIds.map((key) => key.toBase58()),
  );
  for (const instruction of transaction.message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (!program || !allowed.has(program.toBase58()))
      throw new Error("transaction contains a disallowed program");
  }
}

export function deserializeSponsoredTransaction(
  bytes: Uint8Array,
): VersionedTransaction {
  const transaction = VersionedTransaction.deserialize(bytes);
  VersionedMessage.deserialize(transaction.message.serialize());
  return transaction;
}

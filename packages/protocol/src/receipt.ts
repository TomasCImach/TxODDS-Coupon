import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";
import {
  assertLength,
  concatBytes,
  encodeI64,
  encodeU32,
  encodeU64,
  encodeU8,
  type Bytes16,
  type Bytes32,
} from "./bytes.js";

export const RECEIPT_DOMAIN_TAG = Uint8Array.from([
  71, 79, 65, 76, 68, 82, 79, 80, 95, 82, 67, 80, 84, 95, 86, 49,
]);
export const CANONICAL_RECEIPT_LENGTH = 245;

export interface CanonicalReceipt {
  version: number;
  authorityEpoch: number;
  networkDomain: Bytes32;
  programId: Bytes32;
  campaign: Bytes32;
  round: Bytes32;
  wallet: Bytes32;
  intentHash: Bytes32;
  sequence: bigint;
  acceptedAtMs: bigint;
  receiptId: Bytes16;
}

export function encodeReceipt(receipt: CanonicalReceipt): Uint8Array {
  for (const [name, value, length] of [
    ["network domain", receipt.networkDomain, 32],
    ["program ID", receipt.programId, 32],
    ["campaign", receipt.campaign, 32],
    ["round", receipt.round, 32],
    ["wallet", receipt.wallet, 32],
    ["intent hash", receipt.intentHash, 32],
    ["receipt ID", receipt.receiptId, 16],
  ] as const)
    assertLength(value, length, name);
  const encoded = concatBytes(
    RECEIPT_DOMAIN_TAG,
    encodeU8(receipt.version),
    encodeU32(receipt.authorityEpoch),
    receipt.networkDomain,
    receipt.programId,
    receipt.campaign,
    receipt.round,
    receipt.wallet,
    receipt.intentHash,
    encodeU64(receipt.sequence),
    encodeI64(receipt.acceptedAtMs),
    receipt.receiptId,
  );
  assertLength(encoded, CANONICAL_RECEIPT_LENGTH, "canonical receipt");
  return encoded;
}

export function receiptHash(receipt: CanonicalReceipt): Bytes32 {
  return sha256(encodeReceipt(receipt));
}

export function signReceipt(
  receipt: CanonicalReceipt,
  secretKey: Uint8Array,
): Uint8Array {
  assertLength(secretKey, nacl.sign.secretKeyLength, "relayer secret key");
  return nacl.sign.detached(receiptHash(receipt), secretKey);
}

export function verifyReceipt(
  receipt: CanonicalReceipt,
  signature: Uint8Array,
  authority: Uint8Array,
): boolean {
  assertLength(signature, nacl.sign.signatureLength, "receipt signature");
  assertLength(authority, nacl.sign.publicKeyLength, "relayer authority");
  return nacl.sign.detached.verify(receiptHash(receipt), signature, authority);
}

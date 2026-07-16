import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";
import {
  assertLength,
  concatBytes,
  encodeI64,
  encodeU8,
  publicKeyBytes,
  zeroBytes,
  type Bytes16,
  type Bytes32,
} from "./bytes.js";
import { IntentAction, type IntentActionValue } from "./domain.js";

export const INTENT_DOMAIN_TAG = Uint8Array.from([
  71, 79, 65, 76, 68, 82, 79, 80, 95, 86, 49, 0, 0, 0, 0, 0,
]);
export const DEVNET_NETWORK_DOMAIN = sha256(
  new TextEncoder().encode("solana:devnet"),
);
export const CANONICAL_INTENT_LENGTH = 233;

export interface CanonicalIntent {
  networkDomain: Bytes32;
  programId: Bytes32;
  action: IntentActionValue;
  campaign: Bytes32;
  round: Bytes32;
  wallet: Bytes32;
  recipient: Bytes32;
  nonce: Bytes16;
  expiresAt: bigint;
}

export interface IntentFields {
  networkDomain?: Uint8Array;
  programId: string | Uint8Array;
  action: IntentActionValue;
  campaign: string | Uint8Array;
  round?: string | Uint8Array;
  wallet: string | Uint8Array;
  recipient?: string | Uint8Array;
  nonce: Uint8Array;
  expiresAt: bigint;
}

export function canonicalizeIntent(fields: IntentFields): CanonicalIntent {
  if (
    fields.action !== IntentAction.Register &&
    fields.action !== IntentAction.Claim
  ) {
    throw new RangeError("unsupported intent action");
  }
  const networkDomain = fields.networkDomain ?? DEVNET_NETWORK_DOMAIN;
  assertLength(networkDomain, 32, "network domain");
  assertLength(fields.nonce, 16, "nonce");
  const wallet = publicKeyBytes(fields.wallet);
  const recipient = publicKeyBytes(fields.recipient ?? fields.wallet);
  if (!recipient.every((byte, index) => byte === wallet[index])) {
    throw new Error("MVP intents require recipient to equal wallet");
  }
  const round =
    fields.action === IntentAction.Register
      ? zeroBytes(32)
      : publicKeyBytes(fields.round ?? zeroBytes(32));
  if (
    fields.action === IntentAction.Claim &&
    round.every((byte) => byte === 0)
  ) {
    throw new Error("claim intent requires a nonzero round");
  }
  return {
    networkDomain: new Uint8Array(networkDomain),
    programId: publicKeyBytes(fields.programId),
    action: fields.action,
    campaign: publicKeyBytes(fields.campaign),
    round,
    wallet,
    recipient,
    nonce: new Uint8Array(fields.nonce),
    expiresAt: fields.expiresAt,
  };
}

export function encodeIntent(intent: CanonicalIntent): Uint8Array {
  for (const [name, value, length] of [
    ["network domain", intent.networkDomain, 32],
    ["program ID", intent.programId, 32],
    ["campaign", intent.campaign, 32],
    ["round", intent.round, 32],
    ["wallet", intent.wallet, 32],
    ["recipient", intent.recipient, 32],
    ["nonce", intent.nonce, 16],
  ] as const)
    assertLength(value, length, name);
  const encoded = concatBytes(
    INTENT_DOMAIN_TAG,
    intent.networkDomain,
    intent.programId,
    encodeU8(intent.action),
    intent.campaign,
    intent.round,
    intent.wallet,
    intent.recipient,
    intent.nonce,
    encodeI64(intent.expiresAt),
  );
  assertLength(encoded, CANONICAL_INTENT_LENGTH, "canonical intent");
  return encoded;
}

export function intentHash(intent: CanonicalIntent): Bytes32 {
  return sha256(encodeIntent(intent));
}

export function verifyIntentSignature(
  intent: CanonicalIntent,
  signature: Uint8Array,
): boolean {
  assertLength(signature, nacl.sign.signatureLength, "Ed25519 signature");
  return nacl.sign.detached.verify(
    intentHash(intent),
    signature,
    intent.wallet,
  );
}

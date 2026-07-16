import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_INTENT_LENGTH,
  CANONICAL_RECEIPT_LENGTH,
  DEVNET_NETWORK_DOMAIN,
  IntentAction,
  canonicalizeIntent,
  encodeIntent,
  encodeReceipt,
  hex,
  intentHash,
  publicKeyBytes,
  signReceipt,
  verifyIntentSignature,
  verifyReceipt,
  type CanonicalReceipt,
} from "./index.js";

const program = publicKeyBytes("11111111111111111111111111111111");
const campaign = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const round = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const fan = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index),
);

describe("canonical intent", () => {
  it("serializes fixed-width little-endian bytes and verifies the fan signature", () => {
    const intent = canonicalizeIntent({
      programId: program,
      action: IntentAction.Claim,
      campaign,
      round,
      wallet: fan.publicKey,
      nonce: Uint8Array.from({ length: 16 }, (_, index) => index + 10),
      expiresAt: 1_900_000_000n,
    });
    expect(encodeIntent(intent)).toHaveLength(CANONICAL_INTENT_LENGTH);
    expect(hex(encodeIntent(intent).slice(0, 16))).toBe(
      "474f414c44524f505f56310000000000",
    );
    const signature = nacl.sign.detached(intentHash(intent), fan.secretKey);
    expect(verifyIntentSignature(intent, signature)).toBe(true);
  });

  it("forces zero round for registration and rejects redirecting recipients", () => {
    const registration = canonicalizeIntent({
      programId: program,
      action: IntentAction.Register,
      campaign,
      round,
      wallet: fan.publicKey,
      nonce: new Uint8Array(16),
      expiresAt: 1n,
    });
    expect(registration.round).toEqual(new Uint8Array(32));
    expect(() =>
      canonicalizeIntent({
        programId: program,
        action: IntentAction.Claim,
        campaign,
        round,
        wallet: fan.publicKey,
        recipient: campaign,
        nonce: new Uint8Array(16),
        expiresAt: 1n,
      }),
    ).toThrow(/recipient/);
  });

  it("matches the Rust registration golden vector", () => {
    const intent = canonicalizeIntent({
      programId: "2NUW8WnPJpsSruWhQ5as8AeynBDdfhth5YBXpFWfxZnc",
      action: IntentAction.Register,
      campaign: new Uint8Array(32).fill(1),
      wallet: new Uint8Array(32).fill(2),
      nonce: new Uint8Array(16).fill(3),
      expiresAt: 1_900_000_000n,
    });
    expect(hex(intentHash(intent))).toBe(
      "c69df6789d5cb84e09567ff32ef287a62b4e59cd50df694c63ffabfa066be17b",
    );
  });

  it("invalidates the original signature when any security domain field changes", () => {
    const original = canonicalizeIntent({
      programId: program,
      action: IntentAction.Claim,
      campaign,
      round,
      wallet: fan.publicKey,
      nonce: new Uint8Array(16).fill(41),
      expiresAt: 1_900_000_000n,
    });
    const signature = nacl.sign.detached(intentHash(original), fan.secretKey);
    const changed = [
      canonicalizeIntent({
        ...original,
        networkDomain: new Uint8Array(32).fill(1),
      }),
      canonicalizeIntent({
        ...original,
        programId: new Uint8Array(32).fill(2),
      }),
      canonicalizeIntent({
        ...original,
        campaign: new Uint8Array(32).fill(3),
      }),
      canonicalizeIntent({
        ...original,
        round: new Uint8Array(32).fill(4),
      }),
      canonicalizeIntent({
        ...original,
        wallet: new Uint8Array(32).fill(5),
        recipient: new Uint8Array(32).fill(5),
      }),
      canonicalizeIntent({
        ...original,
        nonce: new Uint8Array(16).fill(6),
      }),
      canonicalizeIntent({ ...original, expiresAt: original.expiresAt + 1n }),
    ];

    for (const intent of changed) {
      expect(intentHash(intent)).not.toEqual(intentHash(original));
      expect(verifyIntentSignature(intent, signature)).toBe(false);
    }
    expect(() =>
      canonicalizeIntent({
        ...original,
        recipient: new Uint8Array(32).fill(7),
      }),
    ).toThrow(/recipient/);
  });
});

describe("canonical receipt", () => {
  it("is fixed width and signed by the relayer authority", () => {
    const relayer = nacl.sign.keyPair.fromSeed(
      Uint8Array.from({ length: 32 }, (_, index) => 31 - index),
    );
    const receipt: CanonicalReceipt = {
      version: 1,
      authorityEpoch: 7,
      networkDomain: DEVNET_NETWORK_DOMAIN,
      programId: program,
      campaign,
      round,
      wallet: fan.publicKey,
      intentHash: new Uint8Array(32).fill(9),
      sequence: 1n,
      acceptedAtMs: 1_900_000_000_000n,
      receiptId: new Uint8Array(16).fill(3),
    };
    expect(encodeReceipt(receipt)).toHaveLength(CANONICAL_RECEIPT_LENGTH);
    const signature = signReceipt(receipt, relayer.secretKey);
    expect(verifyReceipt(receipt, signature, relayer.publicKey)).toBe(true);
  });
});

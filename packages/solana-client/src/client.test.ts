import nacl from "tweetnacl";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  assertTransactionSize,
  buildSponsoredV0Transaction,
  campaignPda,
  claimPda,
  configPda,
  decodePlatformConfigAccount,
  fanSignatureVerificationInstruction,
  fixtureSlotPda,
  goalReceiptPda,
  refundCampaignInstruction,
  registerFanInstruction,
  registrationPda,
  roundPda,
  settleClaimInstruction,
  validateSignedTemplate,
  vaultPda,
} from "./index.js";

const programId = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;

describe("GoalDrop PDA derivation", () => {
  it("is stable and isolates campaign, round, event, and wallet", () => {
    const [campaign] = campaignPda(programId, sponsor, 4n);
    expect(
      fixtureSlotPda(programId, 123n)[0].equals(
        fixtureSlotPda(programId, 123n)[0],
      ),
    ).toBe(true);
    expect(
      roundPda(programId, campaign, 0)[0].equals(
        roundPda(programId, campaign, 1)[0],
      ),
    ).toBe(false);
    expect(
      goalReceiptPda(programId, campaign, new Uint8Array(32).fill(8))[0],
    ).toBeInstanceOf(PublicKey);
    expect(
      claimPda(programId, roundPda(programId, campaign, 0)[0], sponsor)[0],
    ).toBeInstanceOf(PublicKey);
  });
});

describe("account decoding", () => {
  it("decodes the fixed PlatformConfig authority and pause layout", () => {
    const data = Buffer.alloc(240);
    const admin = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
    const oracle = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey;
    const relayer = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
    const demo = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey;
    const mint = Keypair.fromSeed(new Uint8Array(32).fill(25)).publicKey;
    data[8] = 1;
    data[9] = 254;
    data.writeUInt16LE(0b1010, 10);
    data.writeUInt32LE(17, 12);
    data.set(admin.toBytes(), 16);
    data.set(oracle.toBytes(), 48);
    data.set(relayer.toBytes(), 80);
    data.set(demo.toBytes(), 112);
    data.set(mint.toBytes(), 144);
    data.set(new Uint8Array(32).fill(7), 176);
    data[208] = 6;

    const decoded = decodePlatformConfigAccount(data);
    expect(decoded).toMatchObject({
      version: 1,
      bump: 254,
      pauseMask: 0b1010,
      authorityEpoch: 17,
      rewardDecimals: 6,
    });
    expect(decoded.admin.equals(admin)).toBe(true);
    expect(decoded.oracle.equals(oracle)).toBe(true);
    expect(decoded.relayer.equals(relayer)).toBe(true);
    expect(decoded.demoAuthority.equals(demo)).toBe(true);
    expect(decoded.rewardMint.equals(mint)).toBe(true);
    expect(decoded.networkDomain).toEqual(new Uint8Array(32).fill(7));
  });
});

describe("gasless transaction primitives", () => {
  it("builds an inline Ed25519 check and a sub-1232-byte v0 transaction", () => {
    const fan = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
    const hash = new Uint8Array(32).fill(3);
    const signature = nacl.sign.detached(hash, fan.secretKey);
    const ed25519 = fanSignatureVerificationInstruction(
      new PublicKey(fan.publicKey),
      hash,
      signature,
    );
    const programInstruction = new TransactionInstruction({
      programId,
      keys: [{ pubkey: sponsor, isSigner: true, isWritable: false }],
      data: Buffer.alloc(128),
    });
    const transaction = buildSponsoredV0Transaction({
      feePayer: sponsor,
      blockhash: {
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 100,
      },
      instructions: [
        ed25519,
        programInstruction,
        SystemProgram.transfer({
          fromPubkey: sponsor,
          toPubkey: sponsor,
          lamports: 0,
        }),
      ],
      compute: { units: 300_000, microLamports: 1_000 },
    });
    expect(assertTransactionSize(transaction)).toBeLessThan(1_232);
  });

  it("pins exact registration, claim, ATA-creation, and refund transaction sizes", () => {
    const feePayer = Keypair.fromSeed(new Uint8Array(32).fill(30)).publicKey;
    const relayer = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey;
    const fanPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
    const fan = new PublicKey(fanPair.publicKey);
    const mint = Keypair.fromSeed(new Uint8Array(32).fill(33)).publicKey;
    const [config] = configPda(programId);
    const [campaign] = campaignPda(programId, sponsor, 8n);
    const [round] = roundPda(programId, campaign, 0);
    const [registration] = registrationPda(programId, campaign, fan);
    const [claim] = claimPda(programId, round, fan);
    const [vault] = vaultPda(programId, campaign);
    const recipientToken = getAssociatedTokenAddressSync(mint, fan);
    const hash = new Uint8Array(32).fill(34);
    const signature = nacl.sign.detached(hash, fanPair.secretKey);
    const ed25519 = fanSignatureVerificationInstruction(fan, hash, signature);
    const blockhash = {
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 100,
    };
    const registrationInstruction = registerFanInstruction(
      programId,
      { config, campaign, wallet: fan, registration, relayer, feePayer },
      { nonce: new Uint8Array(16).fill(35), expiresAt: 1n, intentHash: hash },
    );
    const claimInstruction = settleClaimInstruction(
      programId,
      {
        config,
        campaign,
        round,
        wallet: fan,
        registration,
        claim,
        relayer,
        feePayer,
        vault,
        rewardMint: mint,
        recipientToken,
      },
      {
        sequence: 1n,
        nonce: new Uint8Array(16).fill(36),
        expiresAt: 1n,
        intentHash: hash,
      },
    );
    const sizes = {
      registration: assertTransactionSize(
        buildSponsoredV0Transaction({
          feePayer,
          blockhash,
          instructions: [ed25519, registrationInstruction],
          compute: { units: 180_000, microLamports: 1_000 },
        }),
      ),
      claimExistingAta: assertTransactionSize(
        buildSponsoredV0Transaction({
          feePayer,
          blockhash,
          instructions: [ed25519, claimInstruction],
          compute: { units: 260_000, microLamports: 1_000 },
        }),
      ),
      claimCreateAta: assertTransactionSize(
        buildSponsoredV0Transaction({
          feePayer,
          blockhash,
          instructions: [
            ed25519,
            createAssociatedTokenAccountIdempotentInstruction(
              feePayer,
              recipientToken,
              fan,
              mint,
            ),
            claimInstruction,
          ],
          compute: { units: 320_000, microLamports: 1_000 },
        }),
      ),
      refund: assertTransactionSize(
        buildSponsoredV0Transaction({
          feePayer,
          blockhash,
          instructions: [
            refundCampaignInstruction(programId, {
              campaign,
              vault,
              rewardMint: mint,
              refundWallet: sponsor,
              refundToken: getAssociatedTokenAddressSync(mint, sponsor),
            }),
          ],
        }),
      ),
    };
    expect(sizes).toEqual({
      registration: 763,
      claimExistingAta: 970,
      claimCreateAta: 1_012,
      refund: 377,
    });
  });

  it("co-signs only the exact issued message with a valid actor signature", () => {
    const feePayer = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const actor = Keypair.fromSeed(new Uint8Array(32).fill(10));
    const issued = buildSponsoredV0Transaction({
      feePayer: feePayer.publicKey,
      blockhash: {
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 10,
      },
      instructions: [
        SystemProgram.transfer({
          fromPubkey: actor.publicKey,
          toPubkey: sponsor,
          lamports: 1,
        }),
      ],
    });
    const message = issued.message.serialize();
    expect(() =>
      validateSignedTemplate(issued, {
        feePayer: feePayer.publicKey,
        requiredSigner: actor.publicKey,
        allowedProgramIds: [SystemProgram.programId],
        templateMessageBytes: message,
        expiresAt: new Date(Date.now() + 10_000),
      }),
    ).toThrow(/signature is invalid/);
    issued.sign([actor]);
    expect(() =>
      validateSignedTemplate(issued, {
        feePayer: feePayer.publicKey,
        requiredSigner: actor.publicKey,
        allowedProgramIds: [SystemProgram.programId],
        templateMessageBytes: message,
        expiresAt: new Date(Date.now() + 10_000),
      }),
    ).not.toThrow();

    const altered = buildSponsoredV0Transaction({
      feePayer: feePayer.publicKey,
      blockhash: {
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 10,
      },
      instructions: [
        SystemProgram.transfer({
          fromPubkey: actor.publicKey,
          toPubkey: sponsor,
          lamports: 2,
        }),
      ],
    });
    altered.sign([actor]);
    expect(() =>
      validateSignedTemplate(altered, {
        feePayer: feePayer.publicKey,
        requiredSigner: actor.publicKey,
        allowedProgramIds: [SystemProgram.programId],
        templateMessageBytes: message,
        expiresAt: new Date(Date.now() + 10_000),
      }),
    ).toThrow(/differs from issued template/);
  });
});

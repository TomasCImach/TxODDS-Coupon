import type { DatabasePool } from "@goaldrop/db";
import { RoundSource } from "@goaldrop/protocol";
import type { CampaignAccount } from "@goaldrop/solana-client";
import {
  Connection,
  Keypair,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import type { ServiceConfig } from "../config.js";
import { processCompletion } from "./oracle.js";
import { resolveGoalRound, sendWorkerTransaction } from "./solana.js";

describe("worker transaction reconciliation", () => {
  it("recovers the original round from a receipt after next_round advances", () => {
    const programId = Keypair.generate().publicKey;
    const campaignAddress = Keypair.generate().publicKey;
    const eventHash = new Uint8Array(32).fill(19);
    const receiptData = Buffer.alloc(168);
    receiptData[10] = RoundSource.Live;
    receiptData[11] = 0;
    receiptData.set(campaignAddress.toBytes(), 12);
    receiptData.set(eventHash, 44);
    const result = resolveGoalRound({
      programId,
      campaignAddress,
      campaign: { nextRound: 1, roundCount: 2 } as CampaignAccount,
      eventHash,
      expectedSource: RoundSource.Live,
      receiptInfo: {
        data: receiptData,
        executable: false,
        lamports: 1,
        owner: programId,
        rentEpoch: 0,
      },
    });

    expect(result).toEqual({ ordinal: 0, alreadyOpened: true });
  });

  it("finishes a retried completion from existing terminal chain state", async () => {
    const programId = Keypair.generate().publicKey;
    const campaign = Keypair.generate().publicKey;
    const oracle = Keypair.generate();
    const feePayer = Keypair.generate();
    const campaignData = Buffer.alloc(424);
    campaignData[15] = 1;
    const connection = {
      getAccountInfo: vi.fn().mockResolvedValue({
        data: campaignData,
        executable: false,
        lamports: 1,
        owner: programId,
        rentEpoch: 0,
      }),
      sendRawTransaction: vi.fn(),
    } as unknown as Connection;
    const queries: { sql: string; parameters: unknown[] | undefined }[] = [];
    const pool = {
      query: vi
        .fn()
        .mockImplementation((sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          if (sql.includes("SELECT signature FROM chain_transactions"))
            return Promise.resolve({
              rows: [{ signature: "recorded-signature" }],
            });
          return Promise.resolve({ rows: [] });
        }),
    } as unknown as DatabasePool;

    await processCompletion(
      { GOALDROP_PROGRAM_ID: programId.toBase58() } as ServiceConfig,
      pool,
      connection,
      oracle,
      feePayer,
      {
        id: 1n,
        aggregateType: "campaign",
        aggregateKey: campaign.toBase58(),
        eventType: "match.complete",
        payload: {
          campaign: campaign.toBase58(),
          fixtureId: "1",
          seq: "2",
        },
        traceId: "00000000-0000-4000-8000-000000000002",
        attempts: 2,
      },
    );

    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(queries[1]?.parameters).toEqual([
      campaign.toBase58(),
      "provider_finalised",
    ]);
    expect(JSON.parse(String(queries[2]?.parameters?.[1]))).toMatchObject({
      terminalReason: "provider_finalised",
      transactionSignature: "recorded-signature",
    });
  });

  it("persists the deterministic signature before a lost RPC response", async () => {
    const feePayer = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    let expectedSignature = "";
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash,
        lastValidBlockHeight: 99,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      sendRawTransaction: vi.fn().mockImplementation((bytes: Uint8Array) => {
        expectedSignature = bs58.encode(
          VersionedTransaction.deserialize(bytes).signatures[0]!,
        );
        throw new Error("RPC response was lost");
      }),
    } as unknown as Connection;
    const queries: { sql: string; parameters: unknown[] | undefined }[] = [];
    const pool = {
      query: vi
        .fn()
        .mockImplementation((sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          if (sql.includes("INSERT INTO chain_transactions"))
            return Promise.resolve({ rows: [{ id: "41" }] });
          return Promise.resolve({ rows: [] });
        }),
    } as unknown as DatabasePool;

    await expect(
      sendWorkerTransaction({
        config: {} as ServiceConfig,
        pool,
        connection,
        purpose: "lost-response-test",
        aggregateKey: "campaign:test",
        instructions: [
          SystemProgram.transfer({
            fromPubkey: feePayer.publicKey,
            toPubkey: feePayer.publicKey,
            lamports: 0,
          }),
        ],
        feePayer,
        compute: { units: 20_000, microLamports: 1_000 },
        traceId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("RPC response was lost");

    expect(expectedSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(queries[0]?.parameters?.[2]).toBe(expectedSignature);
    expect(queries[1]?.parameters).toEqual([
      "41",
      "ambiguous",
      "RPC response was lost",
    ]);
  });

  it("classifies a confirmed on-chain error as failed, not ambiguous", async () => {
    const feePayer = Keypair.generate();
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      sendRawTransaction: vi
        .fn()
        .mockImplementation((bytes: Uint8Array) =>
          bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!),
        ),
      confirmTransaction: vi.fn().mockResolvedValue({
        context: { slot: 50 },
        value: { err: { InstructionError: [2, 1] } },
      }),
    } as unknown as Connection;
    const queries: { sql: string; parameters: unknown[] | undefined }[] = [];
    const pool = {
      query: vi
        .fn()
        .mockImplementation((sql: string, parameters?: unknown[]) => {
          queries.push({ sql, parameters });
          return Promise.resolve({
            rows: sql.includes("INSERT INTO chain_transactions")
              ? [{ id: "42" }]
              : [],
          });
        }),
    } as unknown as DatabasePool;

    await expect(
      sendWorkerTransaction({
        config: {} as ServiceConfig,
        pool,
        connection,
        purpose: "confirmed-failure-test",
        aggregateKey: "campaign:test",
        instructions: [
          SystemProgram.transfer({
            fromPubkey: feePayer.publicKey,
            toPubkey: feePayer.publicKey,
            lamports: 0,
          }),
        ],
        feePayer,
        compute: { units: 20_000, microLamports: 1_000 },
      }),
    ).rejects.toThrow("InstructionError");

    expect(queries[2]?.parameters?.[1]).toBe("failed");
  });
});

import { randomBytes } from "node:crypto";
import {
  assertTransactionSize,
  buildSponsoredV0Transaction,
} from "@goaldrop/solana-client";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";
import { keypairFromEnvironment } from "./keys.js";

const endpoint =
  process.env.BENCHMARK_PROBE_RPC_URL ?? "https://api.devnet.solana.com";
if (
  ![
    "https://api.devnet.solana.com",
    "https://explorer-api.devnet.solana.com",
    "https://solana-devnet.api.onfinality.io/public",
  ].includes(endpoint)
)
  throw new Error("probe requires an approved public Devnet RPC");
const connection = new Connection(endpoint, { commitment: "processed" });
if (
  (await connection.getGenesisHash()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("probe RPC is not Solana Devnet");
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
const memoProgram = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const probeNonce = randomBytes(8).toString("hex");
const startingBalance = await connection.getBalance(
  feePayer.publicKey,
  "confirmed",
);
let latest: BlockhashWithExpiryBlockHeight | null = null;
let fetchedAt = 0;
let retries = 0;
const latencies: number[] = [];
const signatures: string[] = [];
const startedAt = Date.now();

for (let index = 0; index < 100; index += 1) {
  if (!latest || Date.now() - fetchedAt > 15_000) {
    latest = await retry(() => connection.getLatestBlockhash("processed"));
    fetchedAt = Date.now();
  }
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: feePayer.publicKey,
        toPubkey: feePayer.publicKey,
        lamports: 0,
      }),
      new TransactionInstruction({
        programId: memoProgram,
        keys: [],
        data: Buffer.from(`GoalDrop public RPC probe ${probeNonce}:${index}`),
      }),
    ],
    compute: { units: 20_000, microLamports: 1_000 },
  });
  transaction.sign([feePayer]);
  assertTransactionSize(transaction);
  const sentAt = Date.now();
  const signature = await retry(() =>
    connection.sendRawTransaction(transaction.serialize(), {
      maxRetries: 0,
      preflightCommitment: "processed",
      skipPreflight: false,
    }),
  );
  latencies.push(Date.now() - sentAt);
  signatures.push(signature);
  await delay(650);
  if ((index + 1) % 10 === 0)
    process.stdout.write(
      `${JSON.stringify({
        phase: "public-rpc-probe",
        processed: index + 1,
        elapsedMs: Date.now() - startedAt,
        retries,
      })}\n`,
    );
}

for (let attempt = 0; attempt < 100; attempt += 1) {
  const statuses = await retry(() =>
    connection.getSignatureStatuses(signatures, {
      searchTransactionHistory: true,
    }),
  );
  if (
    statuses.value.every(
      (status) =>
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized",
    )
  )
    break;
  if (attempt === 99) throw new Error("probe signatures did not all confirm");
  await delay(100);
}
const endingBalance = await connection.getBalance(
  feePayer.publicKey,
  "confirmed",
);
const sorted = [...latencies].sort((left, right) => left - right);
const durationMs = Date.now() - startedAt;
if (durationMs > 120_000)
  throw new Error(`public RPC probe exceeded 120 seconds: ${durationMs} ms`);
process.stdout.write(
  `${JSON.stringify({
    network: "solana:devnet",
    endpoint,
    transactions: signatures.length,
    simulationMode: "rpc-preflight-before-each-broadcast",
    pacedBroadcastAndConfirmationDurationMs: durationMs,
    preflightAndBroadcastLatencyMs: {
      min: sorted[0],
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1),
    },
    retries,
    spentLamports: startingBalance - endingBalance,
    fundsMovedLamports: 0,
    accountsCreated: 0,
  })}\n`,
);
feePayer.secretKey.fill(0);

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 8 ||
        !/429|Too Many Requests|timeout|timed out|fetch failed|ECONN/i.test(
          message,
        )
      )
        throw error;
      retries += 1;
      await delay(Math.min(2_000, 100 * 2 ** attempt));
    }
  }
  throw new Error("RPC retry loop exhausted");
}

function percentile(values: number[], fraction: number): number {
  return values[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ]!;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

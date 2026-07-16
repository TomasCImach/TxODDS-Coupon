import { createHmac } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  assertTransactionSize,
  buildSponsoredV0Transaction,
} from "@goaldrop/solana-client";
import {
  Connection,
  Keypair,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction,
} from "@solana/web3.js";
import { keypairFromEnvironment, publicKeyFromEnvironment } from "./keys.js";

const seedNonce = process.env.BENCHMARK_FAN_SEED_NONCE;
if (!seedNonce || !/^\d+$/.test(seedNonce))
  throw new Error("BENCHMARK_FAN_SEED_NONCE is required");
const endpoints = (
  process.env.BENCHMARK_CLEANUP_RPC_URLS ??
  "https://explorer-api.devnet.solana.com,https://api.devnet.solana.com"
).split(",");
for (const endpoint of endpoints)
  if (
    endpoint !== "https://api.devnet.solana.com" &&
    endpoint !== "https://explorer-api.devnet.solana.com" &&
    endpoint !== "https://solana-devnet.api.onfinality.io/public"
  )
    throw new Error("cleanup requires approved public Devnet RPCs");

const connections = endpoints.map(
  (endpoint) =>
    new Connection(endpoint, {
      commitment: "confirmed",
      wsEndpoint:
        process.env.SOLANA_WS_RPC_URL ?? "wss://api.devnet.solana.com",
    }),
);
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
if (!feePayer.publicKey.equals(operator.publicKey))
  throw new Error("operator must equal fee payer");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
const sponsorToken = getAssociatedTokenAddressSync(
  rewardMint,
  operator.publicKey,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const fans = Array.from({ length: 100 }, (_, index) =>
  Keypair.fromSeed(
    createHmac("sha256", operator.secretKey)
      .update("GoalDrop benchmark fan v1")
      .update(seedNonce)
      .update(String(index))
      .digest(),
  ),
);
const tokenAccounts = fans.map((fan) =>
  getAssociatedTokenAddressSync(
    rewardMint,
    fan.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ),
);
const initialInfos = await connections[0]!.getMultipleAccountsInfo(
  tokenAccounts,
  "confirmed",
);
let cachedBlockhash: {
  value: BlockhashWithExpiryBlockHeight;
  fetchedAt: number;
} | null = null;
let closed = 0;
let alreadyClosed = 0;
let recoveredTokens = 0n;
let retries = 0;

for (let index = 0; index < tokenAccounts.length; index += 1) {
  const info = initialInfos[index];
  if (!info) {
    alreadyClosed += 1;
    continue;
  }
  if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== 165)
    throw new Error(`benchmark token account ${index + 1} is invalid`);
  const account = unpackAccount(tokenAccounts[index]!, info, TOKEN_PROGRAM_ID);
  if (
    !account.owner.equals(fans[index]!.publicKey) ||
    !account.mint.equals(rewardMint)
  )
    throw new Error(`benchmark token account ${index + 1} has wrong authority`);
  const instructions: TransactionInstruction[] = [];
  if (account.amount > 0n)
    instructions.push(
      createTransferCheckedInstruction(
        tokenAccounts[index]!,
        rewardMint,
        sponsorToken,
        fans[index]!.publicKey,
        account.amount,
        6,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  instructions.push(
    createCloseAccountInstruction(
      tokenAccounts[index]!,
      feePayer.publicKey,
      fans[index]!.publicKey,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  const connection = connections[index % connections.length]!;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      if (!cachedBlockhash || Date.now() - cachedBlockhash.fetchedAt > 20_000)
        cachedBlockhash = {
          value: await connection.getLatestBlockhash("confirmed"),
          fetchedAt: Date.now(),
        };
      const transaction = buildSponsoredV0Transaction({
        feePayer: feePayer.publicKey,
        blockhash: cachedBlockhash.value,
        instructions,
        compute: { units: 100_000, microLamports: 1_000 },
      });
      transaction.sign([feePayer, fans[index]!]);
      assertTransactionSize(transaction);
      const simulation = await connection.simulateTransaction(transaction, {
        commitment: "confirmed",
        sigVerify: true,
      });
      if (simulation.value.err)
        throw new Error(
          `cleanup simulation failed: ${JSON.stringify(simulation.value.err)}`,
        );
      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        { maxRetries: 5, skipPreflight: true },
      );
      const confirmation = await connection.confirmTransaction(
        { signature, ...cachedBlockhash.value },
        "confirmed",
      );
      if (confirmation.value.err)
        throw new Error(
          `cleanup transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      closed += 1;
      recoveredTokens += account.amount;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 14 ||
        !/429|Too Many Requests|timeout|timed out/i.test(message)
      )
        throw error;
      retries += 1;
      await delay(Math.min(5_000, 500 * (attempt + 1)));
    }
  }
  if ((index + 1) % 10 === 0)
    process.stdout.write(
      `${JSON.stringify({ phase: "benchmark-wallet-cleanup", scanned: index + 1, closed })}\n`,
    );
  await delay(1_700);
}

const [finalInfos, finalBalance] = await Promise.all([
  connections[0]!.getMultipleAccountsInfo(tokenAccounts, "confirmed"),
  connections[0]!.getBalance(feePayer.publicKey, "confirmed"),
]);
if (finalInfos.some((info) => info !== null))
  throw new Error("not all benchmark token accounts were closed");
process.stdout.write(
  `${JSON.stringify({
    network: "solana:devnet",
    feePayer: feePayer.publicKey.toBase58(),
    seedNonce,
    closed,
    alreadyClosed,
    recoveredTokenBaseUnits: recoveredTokens.toString(),
    rpcRetries: retries,
    endingBalanceLamports: finalBalance,
    secretPersistence: false,
  })}\n`,
);
for (const fan of fans) fan.secretKey.fill(0);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

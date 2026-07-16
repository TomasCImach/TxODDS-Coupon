import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { devnetConnection, keypairFromEnvironment } from "./keys.js";

const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
if (!operator.publicKey.equals(feePayer.publicKey))
  throw new Error(
    "the approved Devnet MVP configuration requires operator and fee payer to match",
  );
const connection = new Connection(devnetConnection(), "confirmed");
const decimals = 6;
const mint = Keypair.generate();
const owner = new PublicKey(
  process.env.DEMO_TOKEN_OWNER ?? operator.publicKey.toBase58(),
);
if (!owner.equals(operator.publicKey))
  throw new Error("the approved reward-token owner must be the operator");
const ownerTokenAccount = getAssociatedTokenAddressSync(
  mint.publicKey,
  owner,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const supply = BigInt(process.env.DEMO_TOKEN_SUPPLY ?? "1000000000000");
if (supply <= 0n)
  throw new Error("DEMO_TOKEN_SUPPLY must be positive base units");
const mintRent = await connection.getMinimumBalanceForRentExemption(
  MINT_SIZE,
  "confirmed",
);
const instructions = [
  SystemProgram.createAccount({
    fromPubkey: feePayer.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: mintRent,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMintInstruction(
    mint.publicKey,
    decimals,
    operator.publicKey,
    null,
    TOKEN_PROGRAM_ID,
  ),
  createAssociatedTokenAccountIdempotentInstruction(
    feePayer.publicKey,
    ownerTokenAccount,
    owner,
    mint.publicKey,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ),
  createMintToInstruction(
    mint.publicKey,
    ownerTokenAccount,
    operator.publicKey,
    supply,
    [],
    TOKEN_PROGRAM_ID,
  ),
];

async function buildAndSimulate(): Promise<{
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  feeLamports: number | null;
  unitsConsumed: number | null;
  logCount: number;
}> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([feePayer, mint]);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(
      `reward-mint simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  const fee = await connection.getFeeForMessage(message, "confirmed");
  return {
    transaction,
    ...latest,
    feeLamports: fee.value,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    logCount: simulation.value.logs?.length ?? 0,
  };
}

const preview = await buildAndSimulate();
process.stdout.write(
  `${JSON.stringify(
    {
      stage: "reward-mint-simulated",
      network: "solana:devnet",
      feePayer: feePayer.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
      mintAuthority: operator.publicKey.toBase58(),
      owner: owner.toBase58(),
      ownerTokenAccount: ownerTokenAccount.toBase58(),
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      decimals,
      freezeAuthority: null,
      supplyBaseUnits: supply.toString(),
      mintRentLamports: mintRent,
      estimatedTransactionFeeLamports: preview.feeLamports,
      unitsConsumed: preview.unitsConsumed,
      logCount: preview.logCount,
      broadcast: false,
    },
    null,
    2,
  )}\n`,
);

if (process.env.MINT_EXECUTION_MODE !== "interactive") process.exit(0);
process.stdout.write("AWAITING_BROADCAST_CONFIRMATION=SEND_OR_ABORT\n");
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.once("data", (data) => {
  void broadcast(
    typeof data === "string" ? data : data.toString("utf8"),
  ).finally(() => process.stdin.pause());
});

async function broadcast(input: string): Promise<void> {
  if (input.trim() !== "SEND") {
    process.stdout.write("MINT_TRANSACTION_ABORTED=true\n");
    process.exitCode = 0;
    return;
  }
  try {
    const ready = await buildAndSimulate();
    const signature = await connection.sendRawTransaction(
      ready.transaction.serialize(),
      { maxRetries: 3, skipPreflight: false },
    );
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: ready.blockhash,
        lastValidBlockHeight: ready.lastValidBlockHeight,
      },
      "confirmed",
    );
    if (confirmation.value.err)
      throw new Error(
        `reward-mint transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      );
    const mintState = await getMint(
      connection,
      mint.publicKey,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    const tokenState = await getAccount(
      connection,
      ownerTokenAccount,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (
      mintState.decimals !== decimals ||
      mintState.freezeAuthority !== null ||
      !mintState.mintAuthority?.equals(operator.publicKey)
    )
      throw new Error("created mint failed policy readback");
    if (
      !tokenState.owner.equals(owner) ||
      !tokenState.mint.equals(mint.publicKey) ||
      tokenState.amount !== supply
    )
      throw new Error("operator token account failed readback");
    process.stdout.write(
      `${JSON.stringify(
        {
          stage: "reward-mint-confirmed",
          network: "solana:devnet",
          signature,
          slot: confirmation.context.slot,
          mint: mint.publicKey.toBase58(),
          mintAuthority: mintState.mintAuthority.toBase58(),
          owner: tokenState.owner.toBase58(),
          ownerTokenAccount: ownerTokenAccount.toBase58(),
          supplyBaseUnits: tokenState.amount.toString(),
          decimals: mintState.decimals,
          freezeAuthority: null,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `MINT_BROADCAST_ERROR=${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exitCode = 1;
  }
}

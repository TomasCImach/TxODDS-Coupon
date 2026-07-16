import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DEVNET_NETWORK_DOMAIN } from "@goaldrop/protocol";
import {
  anchorDiscriminator,
  buildSponsoredV0Transaction,
  configPda,
  decodePlatformConfigAccount,
  initializeConfigInstruction,
} from "@goaldrop/solana-client";
import { Connection } from "@solana/web3.js";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

const admin = await keypairFromEnvironment("ADMIN_KEYPAIR");
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
const oracle = publicKeyFromEnvironment("ORACLE_AUTHORITY");
const relayer = publicKeyFromEnvironment("RELAYER_AUTHORITY");
const demoAuthority = publicKeyFromEnvironment("DEMO_AUTHORITY");
const authorities = [admin.publicKey, oracle, relayer, demoAuthority];
if (
  new Set(authorities.map((key) => key.toBase58())).size !== authorities.length
)
  throw new Error(
    "admin, oracle, relayer, and demo authorities must be distinct",
  );

const connection = new Connection(devnetConnection(), "confirmed");
const mint = await getMint(
  connection,
  rewardMint,
  "confirmed",
  TOKEN_PROGRAM_ID,
);
if (mint.decimals !== 6 || mint.freezeAuthority !== null)
  throw new Error(
    "reward mint must be classic SPL, six decimals, and have no freeze authority",
  );
const [config] = configPda(programId);
if (await connection.getAccountInfo(config, "confirmed"))
  throw new Error(`PlatformConfig ${config.toBase58()} already exists`);

const instruction = initializeConfigInstruction(
  programId,
  { config, admin: admin.publicKey, rewardMint },
  {
    oracle,
    relayer,
    demoAuthority,
    networkDomain: DEVNET_NETWORK_DOMAIN,
    rewardDecimals: mint.decimals,
  },
);

async function buildAndSimulate() {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: admin.publicKey,
    blockhash: latest,
    instructions: [instruction],
  });
  transaction.sign([admin]);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(
      `initialize simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  const fee = await connection.getFeeForMessage(
    transaction.message,
    "confirmed",
  );
  return {
    transaction,
    ...latest,
    feeLamports: fee.value,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    logCount: simulation.value.logs?.length ?? 0,
  };
}

const configRentLamports = await connection.getMinimumBalanceForRentExemption(
  240,
  "confirmed",
);
const preview = await buildAndSimulate();
process.stdout.write(
  `${JSON.stringify(
    {
      stage: "platform-config-simulated",
      network: "solana:devnet",
      programId: programId.toBase58(),
      config: config.toBase58(),
      feePayer: admin.publicKey.toBase58(),
      admin: admin.publicKey.toBase58(),
      rewardMint: rewardMint.toBase58(),
      oracle: oracle.toBase58(),
      relayer: relayer.toBase58(),
      demoAuthority: demoAuthority.toBase58(),
      configRentLamports,
      estimatedTransactionFeeLamports: preview.feeLamports,
      unitsConsumed: preview.unitsConsumed,
      logCount: preview.logCount,
      broadcast: false,
    },
    null,
    2,
  )}\n`,
);

if (process.env.INITIALIZE_EXECUTION_MODE !== "interactive") process.exit(0);
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
    process.stdout.write("INITIALIZE_TRANSACTION_ABORTED=true\n");
    return;
  }
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
      `initialize failed: ${JSON.stringify(confirmation.value.err)}`,
    );

  const account = await connection.getAccountInfo(config, "confirmed");
  if (
    !account ||
    !account.owner.equals(programId) ||
    account.data.length !== 240
  )
    throw new Error("PlatformConfig owner or length readback failed");
  const expectedDiscriminator = anchorDiscriminator(
    "account",
    "PlatformConfig",
  );
  if (!account.data.subarray(0, 8).equals(expectedDiscriminator))
    throw new Error("PlatformConfig discriminator readback failed");
  const decoded = decodePlatformConfigAccount(account.data);
  if (
    decoded.version !== 1 ||
    decoded.pauseMask !== 0 ||
    decoded.authorityEpoch !== 0 ||
    !decoded.admin.equals(admin.publicKey) ||
    !decoded.oracle.equals(oracle) ||
    !decoded.relayer.equals(relayer) ||
    !decoded.demoAuthority.equals(demoAuthority) ||
    !decoded.rewardMint.equals(rewardMint) ||
    decoded.rewardDecimals !== mint.decimals ||
    !Buffer.from(decoded.networkDomain).equals(
      Buffer.from(DEVNET_NETWORK_DOMAIN),
    ) ||
    !account.data.subarray(209).every((byte) => byte === 0)
  )
    throw new Error("PlatformConfig field readback failed");

  process.stdout.write(
    `${JSON.stringify(
      {
        stage: "platform-config-confirmed",
        network: "solana:devnet",
        signature,
        slot: confirmation.context.slot,
        programId: programId.toBase58(),
        config: config.toBase58(),
        admin: decoded.admin.toBase58(),
        rewardMint: decoded.rewardMint.toBase58(),
        oracle: decoded.oracle.toBase58(),
        relayer: decoded.relayer.toBase58(),
        demoAuthority: decoded.demoAuthority.toBase58(),
        rewardDecimals: decoded.rewardDecimals,
        pauseMask: decoded.pauseMask,
        authorityEpoch: decoded.authorityEpoch,
      },
      null,
      2,
    )}\n`,
  );
}

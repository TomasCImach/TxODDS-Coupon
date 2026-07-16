import {
  buildSponsoredV0Transaction,
  configPda,
  decodePlatformConfigAccount,
  type PlatformConfigAccount,
} from "@goaldrop/solana-client";
import {
  Connection,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

export interface AdminChangeResult {
  network: "solana:devnet";
  programId: string;
  config: string;
  admin: string;
  reason: string;
  dryRun: boolean;
  signature: string | null;
  before: PlatformConfigAccount;
  after: PlatformConfigAccount;
}

export async function executeAdminChange(input: {
  instruction(context: {
    programId: PublicKey;
    config: PublicKey;
    admin: PublicKey;
    before: PlatformConfigAccount;
  }): TransactionInstruction;
  verify(before: PlatformConfigAccount, after: PlatformConfigAccount): boolean;
}): Promise<AdminChangeResult> {
  const reason = process.env.AUDIT_REASON?.trim() ?? "";
  if (reason.length < 12 || reason.length > 240)
    throw new Error("AUDIT_REASON must contain 12 to 240 characters");
  const dryRun = process.env.DRY_RUN !== "false";
  const admin = await keypairFromEnvironment("ADMIN_KEYPAIR");
  const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
  const [config] = configPda(programId);
  const connection = new Connection(devnetConnection(), "confirmed");
  const before = await readPlatformConfig(connection, programId, config);
  if (!before.admin.equals(admin.publicKey))
    throw new Error("ADMIN_KEYPAIR does not match the on-chain administrator");
  const expectedEpoch = process.env.EXPECTED_AUTHORITY_EPOCH;
  if (
    expectedEpoch !== undefined &&
    Number(expectedEpoch) !== before.authorityEpoch
  )
    throw new Error(
      `authority epoch changed: expected ${expectedEpoch}, observed ${before.authorityEpoch}`,
    );
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: admin.publicKey,
    blockhash,
    instructions: [
      input.instruction({
        programId,
        config,
        admin: admin.publicKey,
        before,
      }),
    ],
  });
  transaction.sign([admin]);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(
      `admin change simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  if (dryRun)
    return {
      network: "solana:devnet",
      programId: programId.toBase58(),
      config: config.toBase58(),
      admin: admin.publicKey.toBase58(),
      reason,
      dryRun,
      signature: null,
      before,
      after: before,
    };
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { maxRetries: 2, skipPreflight: true },
  );
  const confirmation = await connection.confirmTransaction(
    { signature, ...blockhash },
    "confirmed",
  );
  if (confirmation.value.err)
    throw new Error(
      `admin change failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  const after = await readPlatformConfig(connection, programId, config);
  if (!input.verify(before, after))
    throw new Error("admin change readback did not match the requested state");
  return {
    network: "solana:devnet",
    programId: programId.toBase58(),
    config: config.toBase58(),
    admin: admin.publicKey.toBase58(),
    reason,
    dryRun,
    signature,
    before,
    after,
  };
}

function readPlatformConfig(
  connection: Connection,
  programId: PublicKey,
  config: PublicKey,
): Promise<PlatformConfigAccount> {
  return connection.getAccountInfo(config, "confirmed").then((account) => {
    if (!account || !account.owner.equals(programId))
      throw new Error("PlatformConfig is absent or owned by another program");
    return decodePlatformConfigAccount(account.data);
  });
}

export function printableConfig(config: PlatformConfigAccount) {
  return {
    version: config.version,
    pauseMask: config.pauseMask,
    authorityEpoch: config.authorityEpoch,
    admin: config.admin.toBase58(),
    oracle: config.oracle.toBase58(),
    relayer: config.relayer.toBase58(),
    demoAuthority: config.demoAuthority.toBase58(),
    rewardMint: config.rewardMint.toBase58(),
    rewardDecimals: config.rewardDecimals,
  };
}

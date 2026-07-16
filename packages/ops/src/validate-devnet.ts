import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAccount, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CampaignState, DEVNET_NETWORK_DOMAIN } from "@goaldrop/protocol";
import {
  anchorDiscriminator,
  configPda,
  decodeCampaignAccount,
  decodePlatformConfigAccount,
  vaultPda,
} from "@goaldrop/solana-client";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

interface DeploymentManifest {
  program: {
    address: string;
    programData: string;
    upgradeAuthority: string;
    binarySha256: string;
    binaryLength: number;
  };
  demoCampaign: {
    address: string;
    fixtureId: string;
    campaignNonce: string;
    requiredFundingBaseUnits: string;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(
  await readFile(
    new URL("../../../docs/devnet-deployment.json", import.meta.url),
    "utf8",
  ),
) as DeploymentManifest;
const connection = new Connection(devnetConnection(), "confirmed");
const genesisHash = await connection.getGenesisHash();
assert(genesisHash === DEVNET_GENESIS, "RPC is not Solana Devnet");

const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
assert(
  programId.equals(new PublicKey(manifest.program.address)),
  "program ID disagrees with the deployment manifest",
);
const programInfo = await connection.getAccountInfo(programId, "confirmed");
assert(programInfo, "program account is absent");
assert(
  programInfo.owner.equals(UPGRADEABLE_LOADER),
  "program has wrong loader",
);
assert(programInfo.executable, "program account is not executable");
assert(
  programInfo.data.length === 36 && programInfo.data.readUInt32LE(0) === 2,
  "program account has an invalid upgradeable-loader layout",
);
const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
assert(
  programDataAddress.equals(new PublicKey(manifest.program.programData)),
  "ProgramData address disagrees with the deployment manifest",
);
const programDataInfo = await connection.getAccountInfo(
  programDataAddress,
  "confirmed",
);
assert(programDataInfo, "ProgramData account is absent");
assert(
  programDataInfo.owner.equals(UPGRADEABLE_LOADER) &&
    !programDataInfo.executable &&
    programDataInfo.data.readUInt32LE(0) === 3,
  "ProgramData owner or layout is invalid",
);
assert(programDataInfo.data[12] === 1, "ProgramData has no upgrade authority");
const upgradeAuthority = new PublicKey(programDataInfo.data.subarray(13, 45));
assert(
  upgradeAuthority.equals(new PublicKey(manifest.program.upgradeAuthority)),
  "upgrade authority disagrees with the deployment manifest",
);
const deployedCode = programDataInfo.data.subarray(45);
assert(
  deployedCode.length === manifest.program.binaryLength,
  "deployed program length disagrees with the deployment manifest",
);
const deployedSha256 = createHash("sha256").update(deployedCode).digest("hex");
assert(
  deployedSha256 === manifest.program.binarySha256,
  "deployed program hash disagrees with the deployment manifest",
);

const admin = await keypairFromEnvironment("ADMIN_KEYPAIR");
const oracle = await keypairFromEnvironment("ORACLE_KEYPAIR");
const relayer = await keypairFromEnvironment("RELAYER_KEYPAIR");
const demoAuthority = await keypairFromEnvironment("DEMO_AUTHORITY_KEYPAIR");
const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
assert(
  operator.publicKey.equals(feePayer.publicKey),
  "operator and fee payer must match for the approved Devnet exception",
);

const [configAddress] = configPda(programId);
const configInfo = await connection.getAccountInfo(configAddress, "confirmed");
assert(configInfo, "PlatformConfig is absent");
assert(
  configInfo.owner.equals(programId) && configInfo.data.length === 240,
  "PlatformConfig owner or length is invalid",
);
assert(
  configInfo.data
    .subarray(0, 8)
    .equals(anchorDiscriminator("account", "PlatformConfig")),
  "PlatformConfig discriminator is invalid",
);
const platform = decodePlatformConfigAccount(configInfo.data);
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
assert(platform.version === 1, "PlatformConfig version is invalid");
assert(platform.pauseMask === 0, "PlatformConfig is paused");
assert(platform.authorityEpoch === 0, "unexpected initial authority epoch");
assert(platform.admin.equals(admin.publicKey), "admin keypair mismatch");
assert(platform.oracle.equals(oracle.publicKey), "oracle keypair mismatch");
assert(platform.relayer.equals(relayer.publicKey), "relayer keypair mismatch");
assert(
  platform.demoAuthority.equals(demoAuthority.publicKey),
  "demo authority keypair mismatch",
);
assert(platform.rewardMint.equals(rewardMint), "reward mint mismatch");
assert(platform.rewardDecimals === 6, "reward decimals must be six");
assert(
  Buffer.from(platform.networkDomain).equals(
    Buffer.from(DEVNET_NETWORK_DOMAIN),
  ),
  "network domain is not Devnet",
);

const mint = await getMint(
  connection,
  rewardMint,
  "confirmed",
  TOKEN_PROGRAM_ID,
);
assert(mint.decimals === 6, "reward mint decimals are invalid");
assert(mint.freezeAuthority === null, "reward mint has a freeze authority");
assert(
  mint.mintAuthority?.equals(operator.publicKey),
  "operator does not control the reward mint",
);

const campaignAddress = publicKeyFromEnvironment("DEMO_CAMPAIGN");
assert(
  campaignAddress.equals(new PublicKey(manifest.demoCampaign.address)),
  "demo campaign disagrees with the deployment manifest",
);
const campaignInfo = await connection.getAccountInfo(
  campaignAddress,
  "confirmed",
);
assert(campaignInfo, "demo campaign is absent");
assert(
  campaignInfo.owner.equals(programId) && campaignInfo.data.length === 424,
  "demo campaign owner or length is invalid",
);
assert(
  campaignInfo.data
    .subarray(0, 8)
    .equals(anchorDiscriminator("account", "Campaign")),
  "demo campaign discriminator is invalid",
);
const campaign = decodeCampaignAccount(campaignInfo.data);
assert(campaign.state === CampaignState.Active, "demo campaign is not active");
assert(campaign.sponsor.equals(operator.publicKey), "demo sponsor mismatch");
assert(
  campaign.refundWallet.equals(operator.publicKey),
  "demo refund wallet mismatch",
);
assert(campaign.rewardMint.equals(rewardMint), "demo campaign mint mismatch");
assert(
  campaign.fixtureId === BigInt(manifest.demoCampaign.fixtureId) &&
    campaign.campaignNonce === BigInt(manifest.demoCampaign.campaignNonce),
  "demo fixture or nonce mismatch",
);
assert(
  campaign.requiredFunding ===
    BigInt(manifest.demoCampaign.requiredFundingBaseUnits),
  "demo required funding mismatch",
);
assert(
  campaign.fundedAmount === campaign.requiredFunding &&
    campaign.refundedAmount === 0n &&
    campaign.paidAmount <= campaign.fundedAmount + campaign.externalInflowTotal,
  "demo campaign accounting counters are invalid",
);
const now = BigInt(Math.floor(Date.now() / 1_000));
assert(now <= campaign.registrationDeadline, "demo registration is closed");
assert(now < campaign.hardExpiry, "demo campaign has expired");
const [vaultAddress] = vaultPda(programId, campaignAddress);
const vault = await getAccount(
  connection,
  vaultAddress,
  "confirmed",
  TOKEN_PROGRAM_ID,
);
assert(vault.owner.equals(campaignAddress), "demo vault authority is invalid");
assert(vault.mint.equals(rewardMint), "demo vault mint is invalid");
const expectedVaultAmount =
  campaign.fundedAmount +
  campaign.externalInflowTotal -
  campaign.paidAmount -
  campaign.refundedAmount;
assert(vault.amount === expectedVaultAmount, "demo vault is not solvent");

const maximumWinners = campaign.rounds.reduce(
  (total, round) => total + round.winnerCap,
  0,
);
const rentValues = await Promise.all(
  [128, 200, 165, 216, 168].map((space) =>
    connection.getMinimumBalanceForRentExemption(space, "confirmed"),
  ),
);
const registrationRent = rentValues[0]!;
const claimRent = rentValues[1]!;
const ataRent = rentValues[2]!;
const roundRent = rentValues[3]!;
const goalReceiptRent = rentValues[4]!;
const worstCaseDemoRentLamports =
  maximumWinners * (registrationRent + claimRent + ataRent) +
  campaign.roundCount * (roundRent + goalReceiptRent);
const feePayerBalanceLamports = await connection.getBalance(
  feePayer.publicKey,
  "confirmed",
);
const admissionThresholdLamports = Number(
  process.env.FEE_PAYER_MIN_LAMPORTS ?? "10000000000",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "valid",
      network: "solana:devnet",
      genesisHash,
      rpc: devnetConnection(),
      program: {
        address: programId.toBase58(),
        executable: true,
        programData: programDataAddress.toBase58(),
        upgradeAuthority: upgradeAuthority.toBase58(),
        codeLength: deployedCode.length,
        codeSha256: deployedSha256,
      },
      platformConfig: {
        address: configAddress.toBase58(),
        authorityEpoch: platform.authorityEpoch,
        pauseMask: platform.pauseMask,
      },
      rewardMint: {
        address: rewardMint.toBase58(),
        decimals: mint.decimals,
        supplyBaseUnits: mint.supply.toString(),
        freezeAuthority: null,
        mintAuthority: mint.mintAuthority?.toBase58(),
      },
      demoCampaign: {
        address: campaignAddress.toBase58(),
        state: "active",
        vault: vaultAddress.toBase58(),
        vaultAmountBaseUnits: vault.amount.toString(),
        requiredFundingBaseUnits: campaign.requiredFunding.toString(),
        paidAmountBaseUnits: campaign.paidAmount.toString(),
        refundedAmountBaseUnits: campaign.refundedAmount.toString(),
        externalInflowBaseUnits: campaign.externalInflowTotal.toString(),
        roundCount: campaign.roundCount,
        maximumWinners,
        registrationDeadline: campaign.registrationDeadline.toString(),
        hardExpiry: campaign.hardExpiry.toString(),
      },
      feePayer: {
        address: feePayer.publicKey.toBase58(),
        balanceLamports: feePayerBalanceLamports,
        admissionThresholdLamports,
        admissionOpen: feePayerBalanceLamports >= admissionThresholdLamports,
        worstCaseDemoRentLamports,
        balanceAfterWorstCaseDemoRentLamports:
          feePayerBalanceLamports - worstCaseDemoRentLamports,
      },
      secretRoleValidation: {
        admin: "matched",
        oracle: "matched",
        relayerAndReceiptSigner: "matched",
        demoAuthority: "matched",
        operatorAndFeePayer: "matched",
      },
    },
    null,
    2,
  )}\n`,
);

import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { CampaignState } from "@goaldrop/protocol";
import {
  buildSponsoredV0Transaction,
  campaignPda,
  configPda,
  createCampaignInstruction,
  decodeCampaignAccount,
  fixtureSlotPda,
  fundCampaignInstruction,
  sponsorCampaignInstruction,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

type Stage = "create" | "fund" | "activate";

function requiredBigInt(name: string): bigint {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value))
    throw new Error(`${name} must be an unsigned integer`);
  return BigInt(value);
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

const stage = process.env.DEMO_CAMPAIGN_STAGE as Stage | undefined;
if (!stage || !["create", "fund", "activate"].includes(stage))
  throw new Error("DEMO_CAMPAIGN_STAGE must be create, fund, or activate");

const sponsor = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
if (!sponsor.publicKey.equals(feePayer.publicKey))
  throw new Error(
    "the approved Devnet MVP configuration requires operator and fee payer to match",
  );
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
const fixtureId = requiredBigInt("DEMO_FIXTURE_ID");
const campaignNonce = requiredBigInt("DEMO_CAMPAIGN_NONCE");
const scheduledStart = requiredBigInt("DEMO_SCHEDULED_START");
const registrationDeadline = requiredBigInt("DEMO_REGISTRATION_DEADLINE");
const expectedEnd = requiredBigInt("DEMO_EXPECTED_END");
const hardExpiry = requiredBigInt("DEMO_HARD_EXPIRY");
const roundCount = positiveInteger("DEMO_ROUND_COUNT", 3);
const rewardAmount = BigInt(
  positiveInteger("DEMO_REWARD_AMOUNT_BASE_UNITS", 1_000_000),
);
const winnerCap = positiveInteger("DEMO_WINNER_CAP", 5);
if (roundCount > 8 || winnerCap > 100)
  throw new Error("demo round count or winner cap exceeds program bounds");
const rounds = Array.from({ length: roundCount }, () => ({
  rewardAmount,
  winnerCap,
}));
const requiredFunding = rewardAmount * BigInt(winnerCap) * BigInt(roundCount);

const connection = new Connection(devnetConnection(), "confirmed");
const [config] = configPda(programId);
const [fixtureSlot] = fixtureSlotPda(programId, fixtureId);
const [campaign] = campaignPda(programId, sponsor.publicKey, campaignNonce);
const [vault] = vaultPda(programId, campaign);
const sponsorSource = getAssociatedTokenAddressSync(
  rewardMint,
  sponsor.publicKey,
  false,
  TOKEN_PROGRAM_ID,
);

const configInfo = await connection.getAccountInfo(config, "confirmed");
if (
  !configInfo ||
  !configInfo.owner.equals(programId) ||
  configInfo.data.length !== 240
)
  throw new Error("PlatformConfig readback failed");

let instruction: TransactionInstruction;
if (stage === "create") {
  if (await connection.getAccountInfo(campaign, "confirmed"))
    throw new Error(`campaign ${campaign.toBase58()} already exists`);
  if (await connection.getAccountInfo(fixtureSlot, "confirmed"))
    throw new Error(`fixture ${fixtureId} is already reserved`);
  instruction = createCampaignInstruction(
    programId,
    {
      config,
      sponsor: sponsor.publicKey,
      feePayer: feePayer.publicKey,
      refundWallet: sponsor.publicKey,
      rewardMint,
      fixtureSlot,
      campaign,
      vault,
    },
    {
      fixtureId,
      campaignNonce,
      scheduledStart,
      registrationDeadline,
      expectedEnd,
      hardExpiry,
      rounds,
    },
  );
} else {
  const campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
  if (
    !campaignInfo ||
    !campaignInfo.owner.equals(programId) ||
    campaignInfo.data.length !== 424
  )
    throw new Error("campaign account readback failed");
  const campaignState = decodeCampaignAccount(campaignInfo.data);
  if (
    !campaignState.sponsor.equals(sponsor.publicKey) ||
    !campaignState.rewardMint.equals(rewardMint) ||
    campaignState.fixtureId !== fixtureId ||
    campaignState.campaignNonce !== campaignNonce ||
    campaignState.requiredFunding !== requiredFunding
  )
    throw new Error("campaign fields do not match the requested deployment");

  if (stage === "fund") {
    if (campaignState.state !== CampaignState.Draft)
      throw new Error("campaign is not in Draft state");
    const source = await getAccount(
      connection,
      sponsorSource,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (
      !source.owner.equals(sponsor.publicKey) ||
      !source.mint.equals(rewardMint) ||
      source.amount < requiredFunding
    )
      throw new Error("sponsor source account cannot fund the campaign");
    instruction = fundCampaignInstruction(
      programId,
      {
        config,
        sponsor: sponsor.publicKey,
        campaign,
        sponsorSource,
        rewardMint,
        vault,
      },
      requiredFunding,
    );
  } else {
    if (campaignState.state !== CampaignState.Funded)
      throw new Error("campaign is not in Funded state");
    const vaultState = await getAccount(
      connection,
      vault,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (
      !vaultState.owner.equals(campaign) ||
      !vaultState.mint.equals(rewardMint) ||
      vaultState.amount !== requiredFunding
    )
      throw new Error("campaign vault is not exactly funded");
    instruction = sponsorCampaignInstruction(programId, "activate_campaign", {
      config,
      sponsor: sponsor.publicKey,
      campaign,
      vault,
    });
  }
}

function uniqueSigners(...signers: Keypair[]): Keypair[] {
  return signers.filter(
    (signer, index) =>
      signers.findIndex((candidate) =>
        candidate.publicKey.equals(signer.publicKey),
      ) === index,
  );
}

async function buildAndSimulate() {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest,
    instructions: [instruction],
  });
  transaction.sign(uniqueSigners(feePayer, sponsor));
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(
      `${stage} simulation failed: ${JSON.stringify(simulation.value.err)}; logs=${JSON.stringify(simulation.value.logs)}`,
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

const rentLamports =
  stage === "create"
    ? (await connection.getMinimumBalanceForRentExemption(72, "confirmed")) +
      (await connection.getMinimumBalanceForRentExemption(424, "confirmed")) +
      (await connection.getMinimumBalanceForRentExemption(165, "confirmed"))
    : 0;
const preview = await buildAndSimulate();
process.stdout.write(
  `${JSON.stringify(
    {
      stage: `demo-campaign-${stage}-simulated`,
      network: "solana:devnet",
      programId: programId.toBase58(),
      feePayer: feePayer.publicKey.toBase58(),
      sponsor: sponsor.publicKey.toBase58(),
      sourceTokenAccount: sponsorSource.toBase58(),
      rewardMint: rewardMint.toBase58(),
      campaign: campaign.toBase58(),
      fixtureSlot: fixtureSlot.toBase58(),
      vault: vault.toBase58(),
      fixtureId: fixtureId.toString(),
      campaignNonce: campaignNonce.toString(),
      scheduledStart: scheduledStart.toString(),
      registrationDeadline: registrationDeadline.toString(),
      expectedEnd: expectedEnd.toString(),
      hardExpiry: hardExpiry.toString(),
      roundCount,
      rewardAmountBaseUnits: rewardAmount.toString(),
      winnerCap,
      requiredFundingBaseUnits: requiredFunding.toString(),
      accountRentLamports: rentLamports,
      estimatedTransactionFeeLamports: preview.feeLamports,
      unitsConsumed: preview.unitsConsumed,
      logCount: preview.logCount,
      broadcast: false,
    },
    null,
    2,
  )}\n`,
);

if (process.env.DEMO_CAMPAIGN_EXECUTION_MODE !== "interactive") process.exit(0);
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
    process.stdout.write("DEMO_CAMPAIGN_TRANSACTION_ABORTED=true\n");
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
      `${stage} failed: ${JSON.stringify(confirmation.value.err)}`,
    );

  const campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
  if (
    !campaignInfo ||
    !campaignInfo.owner.equals(programId) ||
    campaignInfo.data.length !== 424
  )
    throw new Error("campaign readback failed after broadcast");
  const decoded = decodeCampaignAccount(campaignInfo.data);
  const expectedState =
    stage === "create"
      ? CampaignState.Draft
      : stage === "fund"
        ? CampaignState.Funded
        : CampaignState.Active;
  if (
    decoded.state !== expectedState ||
    decoded.requiredFunding !== requiredFunding ||
    !decoded.sponsor.equals(sponsor.publicKey) ||
    !decoded.rewardMint.equals(rewardMint) ||
    !decoded.refundWallet.equals(sponsor.publicKey) ||
    decoded.fixtureId !== fixtureId ||
    decoded.campaignNonce !== campaignNonce ||
    decoded.roundCount !== roundCount ||
    decoded.scheduledStart !== scheduledStart ||
    decoded.registrationDeadline !== registrationDeadline ||
    decoded.expectedEnd !== expectedEnd ||
    decoded.hardExpiry !== hardExpiry
  )
    throw new Error("campaign field readback failed after broadcast");
  const vaultState = await getAccount(
    connection,
    vault,
    "confirmed",
    TOKEN_PROGRAM_ID,
  );
  const expectedVaultAmount = stage === "create" ? 0n : requiredFunding;
  if (
    !vaultState.owner.equals(campaign) ||
    !vaultState.mint.equals(rewardMint) ||
    vaultState.amount !== expectedVaultAmount
  )
    throw new Error("vault readback failed after broadcast");

  process.stdout.write(
    `${JSON.stringify(
      {
        stage: `demo-campaign-${stage}-confirmed`,
        network: "solana:devnet",
        signature,
        slot: confirmation.context.slot,
        campaign: campaign.toBase58(),
        fixtureSlot: decoded.fixtureSlot.toBase58(),
        vault: vault.toBase58(),
        state: decoded.state,
        requiredFundingBaseUnits: decoded.requiredFunding.toString(),
        fundedAmountBaseUnits: decoded.fundedAmount.toString(),
        vaultAmountBaseUnits: vaultState.amount.toString(),
        activatedAt: decoded.activatedAt.toString(),
      },
      null,
      2,
    )}\n`,
  );
}

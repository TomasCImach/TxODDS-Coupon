import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CampaignState, RoundState, TerminalReason } from "@goaldrop/protocol";
import {
  assertTransactionSize,
  buildSponsoredV0Transaction,
  campaignPda,
  closeRoundInstruction,
  configPda,
  decodeCampaignAccount,
  decodeRoundAccount,
  fixtureSlotPda,
  makeRefundableInstruction,
  markMatchCompleteInstruction,
  refundCampaignInstruction,
  releaseFixtureSlotInstruction,
  roundPda,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

const campaignNonceValue = process.env.BENCHMARK_CAMPAIGN_NONCE;
if (!campaignNonceValue || !/^\d+$/.test(campaignNonceValue))
  throw new Error("BENCHMARK_CAMPAIGN_NONCE is required");
const campaignNonce = BigInt(campaignNonceValue);
const fixtureId = 9_100_000_000_000_000n + (campaignNonce % 999_999_999_999n);
const endpoint = process.env.BENCHMARK_RPC_URL ?? devnetConnection();
const connection = new Connection(endpoint, {
  commitment: "confirmed",
  wsEndpoint: process.env.SOLANA_WS_RPC_URL ?? "wss://api.devnet.solana.com",
});
if (
  (await connection.getGenesisHash()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("benchmark recovery RPC is not Solana Devnet");

const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const oracle = await keypairFromEnvironment("ORACLE_KEYPAIR");
if (!feePayer.publicKey.equals(operator.publicKey))
  throw new Error("operator must equal fee payer");
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
const [config] = configPda(programId);
const [campaign] = campaignPda(programId, operator.publicKey, campaignNonce);
const [round] = roundPda(programId, campaign, 0);
const [vault] = vaultPda(programId, campaign);
const [fixtureSlot] = fixtureSlotPda(programId, fixtureId);
const sponsorToken = getAssociatedTokenAddressSync(
  rewardMint,
  operator.publicKey,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);

let campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
if (
  !campaignInfo ||
  !campaignInfo.owner.equals(programId) ||
  campaignInfo.data.length !== 424
)
  throw new Error("benchmark campaign readback failed");
let campaignState = decodeCampaignAccount(campaignInfo.data);
if (
  campaignState.fixtureId !== fixtureId ||
  campaignState.campaignNonce !== campaignNonce ||
  !campaignState.refundWallet.equals(operator.publicKey)
)
  throw new Error("benchmark campaign identity is invalid");

const roundInfo = await connection.getAccountInfo(round, "confirmed");
if (roundInfo) {
  if (!roundInfo.owner.equals(programId) || roundInfo.data.length !== 216)
    throw new Error("benchmark round readback failed");
  const roundState = decodeRoundAccount(roundInfo.data);
  if (roundState.state === RoundState.Open) {
    const slot = await connection.getSlot("confirmed");
    const chainTime = await connection.getBlockTime(slot);
    if (chainTime === null || BigInt(chainTime) < roundState.closesAt)
      throw new Error("benchmark round is still open");
    await send("close-round", [
      closeRoundInstruction(programId, campaign, round),
    ]);
  }
}

campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
campaignState = decodeCampaignAccount(campaignInfo!.data);
if (
  campaignState.state === CampaignState.Active &&
  campaignState.terminalReason === TerminalReason.None
)
  await send(
    "mark-complete",
    [
      markMatchCompleteInstruction(
        programId,
        { config, campaign, oracle: oracle.publicKey },
        {
          terminalReason: TerminalReason.ProviderFinalised,
          providerActionId: campaignNonce,
          providerSeq: 1,
        },
      ),
    ],
    [feePayer, oracle],
  );

campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
campaignState = decodeCampaignAccount(campaignInfo!.data);
if (campaignState.state === CampaignState.Active)
  await send("make-refundable", [
    makeRefundableInstruction(programId, campaign, vault),
  ]);

campaignInfo = await connection.getAccountInfo(campaign, "confirmed");
campaignState = decodeCampaignAccount(campaignInfo!.data);
if (campaignState.state === CampaignState.Refundable)
  await send("refund", [
    refundCampaignInstruction(programId, {
      campaign,
      vault,
      rewardMint,
      refundWallet: operator.publicKey,
      refundToken: sponsorToken,
    }),
  ]);

if (await connection.getAccountInfo(fixtureSlot, "confirmed"))
  await send("release-fixture", [
    releaseFixtureSlotInstruction(programId, {
      campaign,
      fixtureSlot,
      rentRecipient: operator.publicKey,
    }),
  ]);

const finalInfo = await connection.getAccountInfo(campaign, "confirmed");
if (!finalInfo) throw new Error("final benchmark campaign readback failed");
const finalCampaign = decodeCampaignAccount(finalInfo.data);
const [finalVault, finalFixture, finalBalance] = await Promise.all([
  connection.getAccountInfo(vault, "confirmed"),
  connection.getAccountInfo(fixtureSlot, "confirmed"),
  connection.getBalance(feePayer.publicKey, "confirmed"),
]);
if (
  finalCampaign.state !== CampaignState.Refunded ||
  finalCampaign.fundedAmount !==
    finalCampaign.paidAmount + finalCampaign.refundedAmount ||
  finalVault !== null ||
  finalFixture !== null
)
  throw new Error("benchmark recovery invariant failed");
process.stdout.write(
  `${JSON.stringify({
    network: "solana:devnet",
    campaign: campaign.toBase58(),
    state: finalCampaign.state,
    fundedBaseUnits: finalCampaign.fundedAmount.toString(),
    paidBaseUnits: finalCampaign.paidAmount.toString(),
    refundedBaseUnits: finalCampaign.refundedAmount.toString(),
    vaultClosed: true,
    fixtureReleased: true,
    endingBalanceLamports: finalBalance,
  })}\n`,
);
feePayer.secretKey.fill(0);
operator.secretKey.fill(0);
oracle.secretKey.fill(0);

async function send(
  phase: string,
  instructions: readonly TransactionInstruction[],
  signers: Keypair[] = [feePayer],
): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest,
    instructions,
    compute: { units: 220_000, microLamports: 1_000 },
  });
  transaction.sign(signers);
  const bytes = assertTransactionSize(transaction);
  const simulation = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (simulation.value.err)
    throw new Error(
      `${phase} simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
  const expectedSignature = bs58.encode(transaction.signatures[0]!);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { maxRetries: 5, skipPreflight: true },
  );
  if (signature !== expectedSignature)
    throw new Error(`${phase} returned an unexpected signature`);
  const confirmation = await connection.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (confirmation.value.err)
    throw new Error(
      `${phase} failed: ${JSON.stringify(confirmation.value.err)}`,
    );
  process.stdout.write(
    `${JSON.stringify({
      phase,
      signature,
      transactionBytes: bytes,
      computeUnits: simulation.value.unitsConsumed ?? 0,
    })}\n`,
  );
}

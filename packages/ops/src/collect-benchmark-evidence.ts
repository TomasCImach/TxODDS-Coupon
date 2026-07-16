import { createHash, createHmac } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { CampaignState, RoundState } from "@goaldrop/protocol";
import {
  campaignPda,
  claimPda,
  decodeCampaignAccount,
  decodeClaimAccount,
  decodeRegistrationAccount,
  decodeRoundAccount,
  fixtureSlotPda,
  registrationPda,
  roundPda,
  vaultPda,
} from "@goaldrop/solana-client";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { keypairFromEnvironment, publicKeyFromEnvironment } from "./keys.js";

const campaignNonceValue = process.env.BENCHMARK_CAMPAIGN_NONCE;
const fanSeedNonce = process.env.BENCHMARK_FAN_SEED_NONCE;
if (!campaignNonceValue || !/^\d+$/.test(campaignNonceValue))
  throw new Error("BENCHMARK_CAMPAIGN_NONCE is required");
if (!fanSeedNonce || !/^\d+$/.test(fanSeedNonce))
  throw new Error("BENCHMARK_FAN_SEED_NONCE is required");
const observedDrainMs = Number(process.env.BENCHMARK_OBSERVED_DRAIN_MS);
if (!Number.isInteger(observedDrainMs) || observedDrainMs <= 0)
  throw new Error("BENCHMARK_OBSERVED_DRAIN_MS is required");
const observedClaimRetries = Number(
  process.env.BENCHMARK_OBSERVED_CLAIM_RETRIES ?? "0",
);
if (!Number.isInteger(observedClaimRetries) || observedClaimRetries < 0)
  throw new Error("BENCHMARK_OBSERVED_CLAIM_RETRIES must be nonnegative");

const endpoint =
  process.env.BENCHMARK_EVIDENCE_RPC_URL ?? "https://api.devnet.solana.com";
if (
  ![
    "https://api.devnet.solana.com",
    "https://explorer-api.devnet.solana.com",
    "https://solana-devnet.api.onfinality.io/public",
  ].includes(endpoint)
)
  throw new Error("evidence collection requires an approved public Devnet RPC");
const connection = new Connection(endpoint, { commitment: "confirmed" });
let evidenceRpcRetries = 0;
if (
  (await connection.getGenesisHash()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("evidence RPC is not Solana Devnet");
const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");
const campaignNonce = BigInt(campaignNonceValue);
const fixtureId = 9_100_000_000_000_000n + (campaignNonce % 999_999_999_999n);
const [campaign] = campaignPda(programId, operator.publicKey, campaignNonce);
const [round] = roundPda(programId, campaign, 0);
const [vault] = vaultPda(programId, campaign);
const [fixtureSlot] = fixtureSlotPda(programId, fixtureId);
const fans = Array.from({ length: 100 }, (_, index) =>
  Keypair.fromSeed(
    createHmac("sha256", operator.secretKey)
      .update("GoalDrop benchmark fan v1")
      .update(fanSeedNonce)
      .update(String(index))
      .digest(),
  ),
);
const registrations = fans.map(
  (fan) => registrationPda(programId, campaign, fan.publicKey)[0],
);
const claims = fans.map((fan) => claimPda(programId, round, fan.publicKey)[0]);
const recipientTokens = fans.map((fan) =>
  getAssociatedTokenAddressSync(
    rewardMint,
    fan.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ),
);

const [campaignInfo, roundInfo, registrationInfos, claimInfos, tokenInfos] =
  await Promise.all([
    retry(() => connection.getAccountInfo(campaign, "confirmed")),
    retry(() => connection.getAccountInfo(round, "confirmed")),
    retry(() => connection.getMultipleAccountsInfo(registrations, "confirmed")),
    retry(() => connection.getMultipleAccountsInfo(claims, "confirmed")),
    retry(() =>
      connection.getMultipleAccountsInfo(recipientTokens, "confirmed"),
    ),
  ]);
if (
  !campaignInfo ||
  !campaignInfo.owner.equals(programId) ||
  campaignInfo.data.length !== 424 ||
  !roundInfo ||
  !roundInfo.owner.equals(programId) ||
  roundInfo.data.length !== 216
)
  throw new Error("benchmark campaign or round readback failed");
const campaignState = decodeCampaignAccount(campaignInfo.data);
const roundState = decodeRoundAccount(roundInfo.data);
if (
  campaignState.state !== CampaignState.Refunded ||
  campaignState.fundedAmount !== 100_000_000n ||
  campaignState.paidAmount !== 100_000_000n ||
  campaignState.refundedAmount !== 0n ||
  campaignState.openRoundCount !== 0 ||
  roundState.state !== RoundState.Exhausted ||
  roundState.winnerCount !== 100 ||
  roundState.nextSequence !== 101n ||
  roundState.skippedCount !== 0 ||
  roundState.paidTotal !== 100_000_000n ||
  tokenInfos.some((info) => info !== null)
)
  throw new Error("benchmark terminal invariant failed");

for (let index = 0; index < 100; index += 1) {
  const registrationInfo = registrationInfos[index];
  const claimInfo = claimInfos[index];
  if (
    !registrationInfo ||
    !registrationInfo.owner.equals(programId) ||
    registrationInfo.data.length !== 128 ||
    !claimInfo ||
    !claimInfo.owner.equals(programId) ||
    claimInfo.data.length !== 200
  )
    throw new Error(`participant ${index + 1} account readback failed`);
  const registration = decodeRegistrationAccount(registrationInfo.data);
  const claim = decodeClaimAccount(claimInfo.data);
  if (
    !registration.campaign.equals(campaign) ||
    !registration.wallet.equals(fans[index]!.publicKey) ||
    !claim.campaign.equals(campaign) ||
    !claim.round.equals(round) ||
    !claim.wallet.equals(fans[index]!.publicKey) ||
    !claim.recipient.equals(fans[index]!.publicKey) ||
    claim.sequence !== BigInt(index + 1) ||
    claim.winnerRank !== index + 1 ||
    claim.amount !== 1_000_000n
  )
    throw new Error(`participant ${index + 1} invariant failed`);
}

const signatures: string[] = [];
const slots: number[] = [];
const blockTimes: number[] = [];
for (let index = 0; index < claims.length; index += 1) {
  const history = await retry(() =>
    connection.getSignaturesForAddress(
      claims[index]!,
      { limit: 5 },
      "confirmed",
    ),
  );
  const success = history.find((entry) => entry.err === null);
  if (!success || success.blockTime == null)
    throw new Error(`claim ${index + 1} signature readback failed`);
  signatures.push(success.signature);
  slots.push(success.slot);
  blockTimes.push(success.blockTime);
  if ((index + 1) % 10 === 0)
    process.stdout.write(
      `${JSON.stringify({
        phase: "benchmark-evidence-signatures",
        collected: index + 1,
      })}\n`,
    );
  await delay(275);
}

const transactionBytes: number[] = [];
const computeUnits: number[] = [];
for (let offset = 0; offset < signatures.length; offset += 4) {
  const batch = signatures.slice(offset, offset + 4);
  const transactions = await retry(() =>
    connection.getTransactions(batch, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
  );
  for (const [index, transaction] of transactions.entries()) {
    if (!transaction || transaction.meta?.err)
      throw new Error(
        `claim ${offset + index + 1} transaction readback failed`,
      );
    const units = transaction.meta?.computeUnitsConsumed;
    if (typeof units !== "number")
      throw new Error(`claim ${offset + index + 1} compute units are missing`);
    transactionBytes.push(
      new VersionedTransaction(transaction.transaction.message).serialize()
        .length,
    );
    computeUnits.push(units);
  }
  process.stdout.write(
    `${JSON.stringify({
      phase: "benchmark-evidence-transactions",
      collected: Math.min(offset + 4, signatures.length),
    })}\n`,
  );
  await delay(1_100);
}

const [finalVault, finalFixture, feePayerBalance] = await Promise.all([
  retry(() => connection.getAccountInfo(vault, "confirmed")),
  retry(() => connection.getAccountInfo(fixtureSlot, "confirmed")),
  retry(() => connection.getBalance(operator.publicKey, "confirmed")),
]);
if (finalVault !== null || finalFixture !== null)
  throw new Error("benchmark vault or fixture slot remains open");
const result = {
  schemaVersion: 1,
  collectedAt: new Date().toISOString(),
  network: "solana:devnet",
  rpc: endpoint,
  programId: programId.toBase58(),
  campaign: campaign.toBase58(),
  round: round.toBase58(),
  fixtureSlot: fixtureSlot.toBase58(),
  vault: vault.toBase58(),
  campaignNonce: campaignNonce.toString(),
  fixtureId: fixtureId.toString(),
  judgeCampaignTouched: false,
  fanKeyHandling: "memory-only-deterministic-recovery-zero-persistence",
  registrationCount: 100,
  claimCount: 100,
  contiguousSequences: true,
  contiguousWinnerRanks: true,
  skippedCount: 0,
  rewardAmountBaseUnits: "1000000",
  fundedBaseUnits: campaignState.fundedAmount.toString(),
  paidBaseUnits: campaignState.paidAmount.toString(),
  refundedBaseUnits: campaignState.refundedAmount.toString(),
  observedProcessedDrainMs: observedDrainMs,
  observedTimedClaimRpcRetries: observedClaimRetries,
  evidenceCollectionRpcRetries: evidenceRpcRetries,
  firstOnchainBlockTime: new Date(
    Math.min(...blockTimes) * 1_000,
  ).toISOString(),
  lastOnchainBlockTime: new Date(Math.max(...blockTimes) * 1_000).toISOString(),
  onchainBlockTimeDrainSeconds:
    Math.max(...blockTimes) - Math.min(...blockTimes),
  firstSlot: Math.min(...slots),
  lastSlot: Math.max(...slots),
  transactionBytes: stats(transactionBytes),
  computeUnits: stats(computeUnits),
  firstSignature: signatures[0],
  lastSignature: signatures.at(-1),
  signatureCount: signatures.length,
  signaturesSha256: createHash("sha256")
    .update(signatures.join("\n"))
    .digest("hex"),
  tokenAccountsClosed: tokenInfos.every((info) => info === null),
  vaultClosed: true,
  fixtureReleased: true,
  feePayerBalanceLamports: feePayerBalance,
};
process.stdout.write(`BENCHMARK_EVIDENCE=${JSON.stringify(result)}\n`);
for (const fan of fans) fan.secretKey.fill(0);
operator.secretKey.fill(0);

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 11 ||
        !/429|Too Many Requests|timeout|timed out|fetch failed|ECONN/i.test(
          message,
        )
      )
        throw error;
      evidenceRpcRetries += 1;
      await delay(Math.min(5_000, 250 * 2 ** attempt));
    }
  }
  throw new Error("evidence RPC retry loop exhausted");
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function percentile(values: number[], fraction: number): number {
  return values[
    Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
  ]!;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

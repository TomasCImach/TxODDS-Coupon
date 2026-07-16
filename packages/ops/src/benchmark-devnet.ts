import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  CampaignState,
  IntentAction,
  RoundState,
  TerminalReason,
  canonicalizeIntent,
  intentHash,
} from "@goaldrop/protocol";
import {
  assertTransactionSize,
  buildSponsoredV0Transaction,
  campaignPda,
  claimPda,
  configPda,
  createCampaignInstruction,
  decodeCampaignAccount,
  decodeClaimAccount,
  decodePlatformConfigAccount,
  decodeRegistrationAccount,
  decodeRoundAccount,
  fanSignatureVerificationInstruction,
  fixtureSlotPda,
  fundCampaignInstruction,
  goalReceiptPda,
  makeRefundableInstruction,
  markMatchCompleteInstruction,
  openDemoRoundInstruction,
  refundCampaignInstruction,
  registerFanInstruction,
  registrationPda,
  releaseFixtureSlotInstruction,
  roundPda,
  settleClaimInstruction,
  sponsorCampaignInstruction,
  vaultPda,
} from "@goaldrop/solana-client";
import {
  Connection,
  Keypair,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  devnetConnection,
  keypairFromEnvironment,
  publicKeyFromEnvironment,
} from "./keys.js";

const WINNER_COUNT = 100;
const REWARD_AMOUNT = 1_000_000n;
const FEE_PAYER_FLOOR = 500_000_000;
// Existing benchmark ATAs are reused and closed after invariant readback, so
// the balance may briefly cross the service admission floor but must finish
// above it after their rent is recovered.
const REQUIRED_START_BALANCE = 1_100_000_000;
// The Solana Foundation public endpoint applies method-specific limits. Keep
// pre-round setup serial; the timed claim drain is independently measured.
const REGISTRATION_CONCURRENCY = 1;
let totalRpcRetries = 0;

interface Measurement {
  signature: string;
  bytes: number;
  units: number;
  rpcRetries: number;
  sentAt: number;
  processedAt: number;
  confirmedAt: number;
}

interface BuiltTransaction {
  transaction: ReturnType<typeof buildSponsoredV0Transaction>;
  signature: string;
  bytes: number;
  units: number;
  blockhash: string;
  lastValidBlockHeight: number;
  rpcRetries: number;
  simulationRejected?: boolean;
}

const endpoint = process.env.BENCHMARK_RPC_URL ?? devnetConnection();
const claimEndpoints = (process.env.BENCHMARK_CLAIM_RPC_URLS ?? endpoint).split(
  ",",
);
assertDevnetEndpoint(endpoint);
for (const claimEndpoint of claimEndpoints) assertDevnetEndpoint(claimEndpoint);
let connection = new Connection(endpoint, {
  commitment: "confirmed",
  wsEndpoint: process.env.SOLANA_WS_RPC_URL ?? "wss://api.devnet.solana.com",
});
if (
  (await connection.getGenesisHash()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("benchmark RPC is not Solana Devnet");
let cachedBlockhash: {
  value: BlockhashWithExpiryBlockHeight;
  fetchedAt: number;
} | null = null;
const feePayer = await keypairFromEnvironment("FEE_PAYER_KEYPAIR");
const operator = await keypairFromEnvironment("OPERATOR_KEYPAIR");
const relayer = await keypairFromEnvironment("RELAYER_KEYPAIR");
const demoAuthority = await keypairFromEnvironment("DEMO_AUTHORITY_KEYPAIR");
const oracle = await keypairFromEnvironment("ORACLE_KEYPAIR");
const programId = publicKeyFromEnvironment("GOALDROP_PROGRAM_ID");
const rewardMint = publicKeyFromEnvironment("GOALDROP_REWARD_MINT");

if (!operator.publicKey.equals(feePayer.publicKey))
  throw new Error("operator must equal fee payer for the approved Devnet MVP");

const [config] = configPda(programId);
const configInfo = await rpc(
  () => connection.getAccountInfo(config, "confirmed"),
  "read PlatformConfig",
);
if (
  !configInfo ||
  !configInfo.owner.equals(programId) ||
  configInfo.data.length !== 240
)
  throw new Error("PlatformConfig readback failed");
const platform = decodePlatformConfigAccount(configInfo.data);
if (
  platform.pauseMask !== 0 ||
  !platform.relayer.equals(relayer.publicKey) ||
  !platform.demoAuthority.equals(demoAuthority.publicKey) ||
  !platform.oracle.equals(oracle.publicKey) ||
  !platform.rewardMint.equals(rewardMint) ||
  platform.rewardDecimals !== 6
)
  throw new Error(
    "configured authorities or reward mint do not match PlatformConfig",
  );

const startingBalance = await rpc(
  () => connection.getBalance(feePayer.publicKey, "confirmed"),
  "read starting balance",
);
if (startingBalance < REQUIRED_START_BALANCE)
  throw new Error(
    `fee payer requires at least ${REQUIRED_START_BALANCE} lamports before the benchmark`,
  );

const sponsorToken = getAssociatedTokenAddressSync(
  rewardMint,
  operator.publicKey,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
);
const sponsorTokenState = await rpc(
  () => getAccount(connection, sponsorToken, "confirmed", TOKEN_PROGRAM_ID),
  "read sponsor token account",
);
if (
  !sponsorTokenState.owner.equals(operator.publicKey) ||
  !sponsorTokenState.mint.equals(rewardMint) ||
  sponsorTokenState.amount < REWARD_AMOUNT * BigInt(WINNER_COUNT)
)
  throw new Error("operator token account cannot fund the benchmark");

const campaignNonceValue = process.env.BENCHMARK_CAMPAIGN_NONCE;
if (!campaignNonceValue || !/^\d+$/.test(campaignNonceValue))
  throw new Error(
    "BENCHMARK_CAMPAIGN_NONCE is required for resumable Devnet execution",
  );
const now = BigInt(Math.floor(Date.now() / 1_000));
const campaignNonce = BigInt(campaignNonceValue);
const fanSeedNonce = process.env.BENCHMARK_FAN_SEED_NONCE
  ? BigInt(process.env.BENCHMARK_FAN_SEED_NONCE)
  : campaignNonce;
const fixtureId = 9_100_000_000_000_000n + (campaignNonce % 999_999_999_999n);
const scheduledStart = now + 1_800n;
const registrationDeadline = now + 1_200n;
const expectedEnd = scheduledStart + 10_800n;
const hardExpiry = scheduledStart + 28_800n;
const [fixtureSlot] = fixtureSlotPda(programId, fixtureId);
const [campaign] = campaignPda(programId, operator.publicKey, campaignNonce);
const [vault] = vaultPda(programId, campaign);
const [round] = roundPda(programId, campaign, 0);
const eventHash = digest32(`goaldrop-devnet-benchmark:${campaignNonce}`);
const rawDigest = digest32(`synthetic-devnet-benchmark:${campaignNonce}`);
const [goalReceipt] = goalReceiptPda(programId, campaign, eventHash);
const fans = Array.from({ length: WINNER_COUNT }, (_, index) =>
  Keypair.fromSeed(
    createHmac("sha256", operator.secretKey)
      .update("GoalDrop benchmark fan v1")
      .update(fanSeedNonce.toString())
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
const existingCampaignInfo = await rpc(
  () => connection.getAccountInfo(campaign, "confirmed"),
  "read resumable campaign",
);
if (existingCampaignInfo) {
  if (
    !existingCampaignInfo.owner.equals(programId) ||
    existingCampaignInfo.data.length !== 424
  )
    throw new Error("resumable campaign account is invalid");
  const existing = decodeCampaignAccount(existingCampaignInfo.data);
  if (
    existing.state !== CampaignState.Active ||
    existing.fixtureId !== fixtureId ||
    existing.campaignNonce !== campaignNonce ||
    existing.requiredFunding !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
    existing.fundedAmount !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
    existing.paidAmount !== 0n ||
    existing.nextRound !== 0 ||
    existing.openRoundCount !== 0 ||
    existing.registrationDeadline <= now
  )
    throw new Error("resumable campaign is not safe to continue");
}
const [existingRegistrationInfos, existingRecipientTokenInfos] =
  await Promise.all([
    rpc(
      () => connection.getMultipleAccountsInfo(registrations, "confirmed"),
      "read resumable registrations",
    ),
    rpc(
      () => connection.getMultipleAccountsInfo(recipientTokens, "confirmed"),
      "read resumable recipient accounts",
    ),
  ]);
let preexistingRegistrations = 0;
const initialTokenBalances = new Array<bigint>(WINNER_COUNT).fill(0n);
const winnerTokenBalances = new Array<bigint>(WINNER_COUNT).fill(0n);
for (let index = 0; index < WINNER_COUNT; index += 1) {
  const registrationInfo = existingRegistrationInfos[index];
  const tokenInfo = existingRecipientTokenInfos[index];
  if (!registrationInfo && !tokenInfo) continue;
  if (
    (registrationInfo &&
      (!registrationInfo.owner.equals(programId) ||
        registrationInfo.data.length !== 128)) ||
    (tokenInfo &&
      (!tokenInfo.owner.equals(TOKEN_PROGRAM_ID) ||
        tokenInfo.data.length !== 165)) ||
    (registrationInfo && !tokenInfo)
  )
    throw new Error(`resumable fan ${index + 1} has a partial account set`);
  if (!tokenInfo) continue;
  const token = unpackAccount(
    recipientTokens[index]!,
    tokenInfo,
    TOKEN_PROGRAM_ID,
  );
  if (
    !token.owner.equals(fans[index]!.publicKey) ||
    !token.mint.equals(rewardMint)
  )
    throw new Error(`resumable fan ${index + 1} failed token validation`);
  initialTokenBalances[index] = token.amount;
  if (!registrationInfo) continue;
  if (
    !registrationInfo.owner.equals(programId) ||
    registrationInfo.data.length !== 128 ||
    !tokenInfo.owner.equals(TOKEN_PROGRAM_ID) ||
    tokenInfo.data.length !== 165
  )
    throw new Error(`resumable fan ${index + 1} has invalid accounts`);
  const registration = decodeRegistrationAccount(registrationInfo.data);
  if (
    !registration.campaign.equals(campaign) ||
    !registration.wallet.equals(fans[index]!.publicKey)
  )
    throw new Error(`resumable fan ${index + 1} failed account validation`);
  preexistingRegistrations += 1;
}

process.stdout.write(
  `${stringify({
    phase: "preflight",
    network: "solana:devnet",
    rpc: safeEndpoint(endpoint),
    programId: programId.toBase58(),
    feePayer: feePayer.publicKey.toBase58(),
    startingBalanceLamports: startingBalance,
    campaign: campaign.toBase58(),
    fixtureId: fixtureId.toString(),
    winners: WINNER_COUNT,
    rewardAmountBaseUnits: REWARD_AMOUNT.toString(),
    requiredFundingBaseUnits: (REWARD_AMOUNT * BigInt(WINNER_COUNT)).toString(),
    fanKeyHandling: "memory-only-deterministic-recovery",
    fanSeedNonce: fanSeedNonce.toString(),
    resumedCampaign: existingCampaignInfo !== null,
    preexistingRegistrations,
    judgeCampaignTouched: false,
  })}\n`,
);

const lifecycle: Record<string, Measurement> = {};
if (!existingCampaignInfo) {
  lifecycle.create = await sendMeasured({
    label: "create benchmark campaign",
    instructions: [
      createCampaignInstruction(
        programId,
        {
          config,
          sponsor: operator.publicKey,
          feePayer: feePayer.publicKey,
          refundWallet: operator.publicKey,
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
          rounds: [{ rewardAmount: REWARD_AMOUNT, winnerCap: WINNER_COUNT }],
        },
      ),
    ],
    signers: [feePayer, operator],
    computeUnits: 350_000,
  });
  lifecycle.fund = await sendMeasured({
    label: "fund benchmark campaign",
    instructions: [
      fundCampaignInstruction(
        programId,
        {
          config,
          sponsor: operator.publicKey,
          campaign,
          sponsorSource: sponsorToken,
          rewardMint,
          vault,
        },
        REWARD_AMOUNT * BigInt(WINNER_COUNT),
      ),
    ],
    signers: [feePayer, operator],
  });
  lifecycle.activate = await sendMeasured({
    label: "activate benchmark campaign",
    instructions: [
      sponsorCampaignInstruction(programId, "activate_campaign", {
        config,
        sponsor: operator.publicKey,
        campaign,
        vault,
      }),
    ],
    signers: [feePayer, operator],
  });
}

const registrationStartedAt = Date.now();
const registrationResults = await concurrentMap(
  fans,
  REGISTRATION_CONCURRENCY,
  async (fan, index) => {
    if (existingRegistrationInfos[index]) return null;
    const nonce = randomBytes(16);
    const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 900);
    const hash = intentHash(
      canonicalizeIntent({
        programId: programId.toBytes(),
        action: IntentAction.Register,
        campaign: campaign.toBytes(),
        wallet: fan.publicKey.toBytes(),
        nonce,
        expiresAt,
      }),
    );
    const measurement = await sendMeasured({
      label: `register benchmark fan ${index + 1}`,
      instructions: [
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          recipientTokens[index]!,
          fan.publicKey,
          rewardMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        fanSignatureVerificationInstruction(
          fan.publicKey,
          hash,
          nacl.sign.detached(hash, fan.secretKey),
        ),
        registerFanInstruction(
          programId,
          {
            config,
            campaign,
            wallet: fan.publicKey,
            registration: registrations[index]!,
            relayer: relayer.publicKey,
            feePayer: feePayer.publicKey,
          },
          { nonce, expiresAt, intentHash: hash },
        ),
      ],
      signers: [feePayer, relayer],
      computeUnits: 180_000,
    });
    if ((index + 1) % 10 === 0)
      process.stdout.write(
        `${stringify({ phase: "registrations", confirmed: index + 1 })}\n`,
      );
    await delay(1_700);
    return measurement;
  },
);
const registrationMeasurements = registrationResults.filter(
  (measurement): measurement is Measurement => measurement !== null,
);
const registrationFinishedAt = Date.now();

const claimConnections = claimEndpoints.map(
  (claimEndpoint) =>
    new Connection(claimEndpoint, {
      commitment: "confirmed",
      wsEndpoint:
        process.env.SOLANA_WS_RPC_URL ?? "wss://api.devnet.solana.com",
    }),
);
for (const claimConnection of claimConnections)
  if (
    (await claimConnection.getGenesisHash()) !==
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
  )
    throw new Error("claim RPC is not Solana Devnet");
if (claimEndpoints[0] !== endpoint) {
  connection = new Connection(claimEndpoints[0]!, {
    commitment: "confirmed",
    wsEndpoint: process.env.SOLANA_WS_RPC_URL ?? "wss://api.devnet.solana.com",
  });
}
cachedBlockhash = null;
process.stdout.write(
  `${stringify({ phase: "public-rpc-cooldown", milliseconds: 45_000 })}\n`,
);
await delay(45_000);
connection = claimConnections[0]!;

lifecycle.openRound = await sendMeasured({
  label: "open benchmark round",
  instructions: [
    openDemoRoundInstruction(
      programId,
      {
        config,
        demoAuthority: demoAuthority.publicKey,
        feePayer: feePayer.publicKey,
        campaign,
        round,
        goalReceipt,
      },
      {
        fixtureId,
        eventHash,
        demoNonce: campaignNonce,
        providerTsMs: BigInt(Date.now()),
        rawDigest,
      },
    ),
  ],
  signers: [feePayer, demoAuthority],
  computeUnits: 180_000,
});
const roundOpenedAt = lifecycle.openRound.confirmedAt;

const outOfOrderNonce = randomBytes(16);
const outOfOrderExpiry = BigInt(Math.floor(Date.now() / 1_000) + 600);
const outOfOrderHash = claimIntent(fans[1]!, outOfOrderNonce, outOfOrderExpiry);
const outOfOrder = await buildSimulated({
  label: "out-of-order contention probe",
  instructions: claimInstructions(
    1,
    2n,
    outOfOrderNonce,
    outOfOrderExpiry,
    outOfOrderHash,
  ),
  signers: [feePayer, relayer],
  computeUnits: 120_000,
  expectSimulationFailure: true,
  simulationCommitment: "confirmed",
});
if (!outOfOrder.simulationRejected)
  throw new Error("sequence 2 unexpectedly simulated before sequence 1");

const firstNonce = randomBytes(16);
const firstExpiry = BigInt(Math.floor(Date.now() / 1_000) + 600);
const firstHash = claimIntent(fans[0]!, firstNonce, firstExpiry);
const firstInstructions = claimInstructions(
  0,
  1n,
  firstNonce,
  firstExpiry,
  firstHash,
);
const contentionA = await buildSimulated({
  label: "contention probe A",
  instructions: firstInstructions,
  signers: [feePayer, relayer],
  computeUnits: 120_000,
  microLamports: 1_000,
  simulationCommitment: "confirmed",
});
const contentionB = await buildSimulated({
  label: "contention probe B",
  instructions: firstInstructions,
  signers: [feePayer, relayer],
  computeUnits: 120_000,
  microLamports: 1_001,
  simulationCommitment: "confirmed",
});
const contentionSentAt = Date.now();
await Promise.all([
  broadcast(contentionA, "contention probe A"),
  broadcast(contentionB, "contention probe B"),
]);
const contentionResults = await Promise.all([
  waitForProcessed(contentionA),
  waitForProcessed(contentionB),
]);
const contentionSuccesses = contentionResults.filter(
  (result) => result.error === null,
);
const contentionFailures = contentionResults.filter(
  (result) => result.error !== null,
);
if (contentionSuccesses.length !== 1 || contentionFailures.length !== 1)
  throw new Error("contention probe did not produce exactly one winner");
const firstSuccessful =
  contentionSuccesses[0]!.signature === contentionA.signature
    ? contentionA
    : contentionB;
const claimMeasurements: Measurement[] = [
  {
    signature: firstSuccessful.signature,
    bytes: firstSuccessful.bytes,
    units: firstSuccessful.units,
    rpcRetries: firstSuccessful.rpcRetries,
    sentAt: contentionSentAt,
    processedAt: contentionSuccesses[0]!.observedAt,
    confirmedAt: 0,
  },
];
let claimSubmissionComplete = false;
const confirmationTracker = trackClaimConfirmations(
  claimMeasurements,
  () => claimSubmissionComplete,
);

for (let index = 1; index < WINNER_COUNT; index += 1) {
  connection = claimConnections[index % claimConnections.length]!;
  const nonce = randomBytes(16);
  const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + 600);
  const hash = claimIntent(fans[index]!, nonce, expiresAt);
  const measurement = await sendPreflightMeasured({
    label: `settle benchmark claim ${index + 1}`,
    instructions: claimInstructions(
      index,
      BigInt(index + 1),
      nonce,
      expiresAt,
      hash,
    ),
    signers: [feePayer, relayer],
    computeUnits: 120_000,
  });
  claimMeasurements.push(measurement);
  if ((index + 1) % 10 === 0)
    process.stdout.write(
      `${stringify({
        phase: "claims",
        processed: index + 1,
        elapsedMs: Date.now() - contentionSentAt,
      })}\n`,
    );
}
claimSubmissionComplete = true;
await confirmationTracker;
process.stdout.write(
  `${stringify({
    phase: "claim-drain-complete",
    claims: claimMeasurements.length,
    processedDrainMs: Date.now() - contentionSentAt,
    observedRpcRetries: totalRpcRetries,
  })}\n`,
);
const actualClaimComputeUnits = await readActualComputeUnits(
  claimMeasurements.map((measurement) => measurement.signature),
);
for (const [index, units] of actualClaimComputeUnits.entries())
  claimMeasurements[index]!.units = units;

const [
  campaignInfo,
  roundInfo,
  vaultState,
  registrationInfos,
  claimInfos,
  tokenInfos,
] = await Promise.all([
  rpc(
    () => connection.getAccountInfo(campaign, "confirmed"),
    "read benchmark campaign",
  ),
  rpc(
    () => connection.getAccountInfo(round, "confirmed"),
    "read benchmark round",
  ),
  rpc(
    () => getAccount(connection, vault, "confirmed", TOKEN_PROGRAM_ID),
    "read benchmark vault",
  ),
  rpc(
    () => connection.getMultipleAccountsInfo(registrations, "confirmed"),
    "read registration accounts",
  ),
  rpc(
    () => connection.getMultipleAccountsInfo(claims, "confirmed"),
    "read claim accounts",
  ),
  rpc(
    () => connection.getMultipleAccountsInfo(recipientTokens, "confirmed"),
    "read recipient token accounts",
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
  throw new Error("campaign or round readback is invalid");
const campaignState = decodeCampaignAccount(campaignInfo.data);
const roundState = decodeRoundAccount(roundInfo.data);
if (
  campaignState.state !== CampaignState.Active ||
  campaignState.fundedAmount !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
  campaignState.paidAmount !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
  campaignState.refundedAmount !== 0n ||
  roundState.state !== RoundState.Exhausted ||
  roundState.winnerCount !== WINNER_COUNT ||
  roundState.nextSequence !== BigInt(WINNER_COUNT + 1) ||
  roundState.paidTotal !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
  roundState.skippedCount !== 0 ||
  vaultState.amount !== 0n
)
  throw new Error("final campaign, round, or vault accounting is invalid");

for (let index = 0; index < WINNER_COUNT; index += 1) {
  const registrationInfo = registrationInfos[index];
  const claimInfo = claimInfos[index];
  const tokenInfo = tokenInfos[index];
  if (
    !registrationInfo ||
    !registrationInfo.owner.equals(programId) ||
    registrationInfo.data.length !== 128 ||
    !claimInfo ||
    !claimInfo.owner.equals(programId) ||
    claimInfo.data.length !== 200 ||
    !tokenInfo ||
    !tokenInfo.owner.equals(TOKEN_PROGRAM_ID) ||
    tokenInfo.data.length !== 165
  )
    throw new Error(`winner ${index + 1} account readback is invalid`);
  const registration = decodeRegistrationAccount(registrationInfo.data);
  const claim = decodeClaimAccount(claimInfo.data);
  const token = unpackAccount(
    recipientTokens[index]!,
    tokenInfo,
    TOKEN_PROGRAM_ID,
  );
  if (
    !registration.campaign.equals(campaign) ||
    !registration.wallet.equals(fans[index]!.publicKey) ||
    !claim.campaign.equals(campaign) ||
    !claim.round.equals(round) ||
    !claim.wallet.equals(fans[index]!.publicKey) ||
    !claim.recipient.equals(fans[index]!.publicKey) ||
    claim.sequence !== BigInt(index + 1) ||
    claim.winnerRank !== index + 1 ||
    claim.amount !== REWARD_AMOUNT ||
    !token.owner.equals(fans[index]!.publicKey) ||
    !token.mint.equals(rewardMint) ||
    token.amount !== initialTokenBalances[index]! + REWARD_AMOUNT
  )
    throw new Error(`winner ${index + 1} invariant failed`);
  winnerTokenBalances[index] = token.amount;
}

lifecycle.complete = await sendMeasured({
  label: "complete benchmark campaign",
  instructions: [
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
  signers: [feePayer, oracle],
});
lifecycle.refundable = await sendMeasured({
  label: "make benchmark campaign refundable",
  instructions: [makeRefundableInstruction(programId, campaign, vault)],
  signers: [feePayer],
});
lifecycle.refund = await sendMeasured({
  label: "close zero-balance benchmark vault",
  instructions: [
    refundCampaignInstruction(programId, {
      campaign,
      vault,
      rewardMint,
      refundWallet: operator.publicKey,
      refundToken: sponsorToken,
    }),
  ],
  signers: [feePayer],
});
lifecycle.release = await sendMeasured({
  label: "release benchmark fixture slot",
  instructions: [
    releaseFixtureSlotInstruction(programId, {
      campaign,
      fixtureSlot,
      rentRecipient: operator.publicKey,
    }),
  ],
  signers: [feePayer],
});

process.stdout.write(
  `${stringify({ phase: "wallet-cleanup-cooldown", milliseconds: 45_000 })}\n`,
);
await delay(45_000);
const walletCleanupMeasurements: Measurement[] = [];
for (let index = 0; index < WINNER_COUNT; index += 1) {
  connection = claimConnections[index % claimConnections.length]!;
  walletCleanupMeasurements.push(
    await sendMeasured({
      label: `recover benchmark wallet ${index + 1}`,
      instructions: [
        createTransferCheckedInstruction(
          recipientTokens[index]!,
          rewardMint,
          sponsorToken,
          fans[index]!.publicKey,
          winnerTokenBalances[index]!,
          6,
          [],
          TOKEN_PROGRAM_ID,
        ),
        createCloseAccountInstruction(
          recipientTokens[index]!,
          feePayer.publicKey,
          fans[index]!.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ],
      signers: [feePayer, fans[index]!],
      computeUnits: 100_000,
    }),
  );
  if ((index + 1) % 10 === 0)
    process.stdout.write(
      `${stringify({ phase: "wallet-cleanup", confirmed: index + 1 })}\n`,
    );
}

const [
  finalCampaignInfo,
  finalVaultInfo,
  finalFixtureInfo,
  finalRecipientInfos,
  finalBalance,
] = await Promise.all([
  rpc(
    () => connection.getAccountInfo(campaign, "confirmed"),
    "read final campaign",
  ),
  rpc(() => connection.getAccountInfo(vault, "confirmed"), "read closed vault"),
  rpc(
    () => connection.getAccountInfo(fixtureSlot, "confirmed"),
    "read released fixture",
  ),
  rpc(
    () => connection.getMultipleAccountsInfo(recipientTokens, "confirmed"),
    "read closed benchmark token accounts",
  ),
  rpc(
    () => connection.getBalance(feePayer.publicKey, "confirmed"),
    "read final balance",
  ),
]);
if (!finalCampaignInfo || finalCampaignInfo.data.length !== 424)
  throw new Error("final campaign readback failed");
const finalCampaign = decodeCampaignAccount(finalCampaignInfo.data);
if (
  finalCampaign.state !== CampaignState.Refunded ||
  finalCampaign.paidAmount !== REWARD_AMOUNT * BigInt(WINNER_COUNT) ||
  finalCampaign.refundedAmount !== 0n ||
  finalVaultInfo !== null ||
  finalFixtureInfo !== null ||
  finalRecipientInfos.some((info) => info !== null) ||
  finalBalance < FEE_PAYER_FLOOR
)
  throw new Error("cleanup or fee-payer floor verification failed");

const signatures = claimMeasurements.map(
  (measurement) => measurement.signature,
);
const claimLatencies = claimMeasurements.map(
  (measurement) => measurement.confirmedAt - measurement.sentAt,
);
const result = {
  schemaVersion: 1,
  completedAt: new Date().toISOString(),
  network: "solana:devnet",
  setupRpc: safeEndpoint(endpoint),
  claimRpcs: claimEndpoints.map(safeEndpoint),
  programId: programId.toBase58(),
  feePayer: feePayer.publicKey.toBase58(),
  startingBalanceLamports: startingBalance,
  endingBalanceLamports: finalBalance,
  spentLamports: startingBalance - finalBalance,
  feePayerFloorLamports: FEE_PAYER_FLOOR,
  campaign: campaign.toBase58(),
  fixtureSlot: fixtureSlot.toBase58(),
  vault: vault.toBase58(),
  round: round.toBase58(),
  goalReceipt: goalReceipt.toBase58(),
  fixtureId: fixtureId.toString(),
  campaignNonce: campaignNonce.toString(),
  judgeCampaignTouched: false,
  fanKeyHandling: "memory-only-deterministic-recovery-zero-persistence",
  observedRpcRetries: totalRpcRetries,
  registration: {
    requested: WINNER_COUNT,
    confirmed: registrationInfos.length,
    resumed: preexistingRegistrations,
    newlyConfirmed: registrationMeasurements.length,
    concurrency: REGISTRATION_CONCURRENCY,
    durationMs: registrationFinishedAt - registrationStartedAt,
    transactionBytes: stats(
      registrationMeasurements.map((measurement) => measurement.bytes),
    ),
    computeUnits: stats(
      registrationMeasurements.map((measurement) => measurement.units),
    ),
    rpcRetries: registrationMeasurements.reduce(
      (total, measurement) => total + measurement.rpcRetries,
      0,
    ),
  },
  contention: {
    outOfOrderSimulationRejected: outOfOrder.simulationRejected,
    sameSequenceTransactionsSimulated: 2,
    sameSequenceTransactionsSubmitted: 2,
    successful: contentionSuccesses.length,
    expectedFailures: contentionFailures.length,
    failedSignature: contentionFailures[0]!.signature,
    failedError: contentionFailures[0]!.error,
  },
  claims: {
    requested: WINNER_COUNT,
    confirmed: roundState.winnerCount,
    skipped: roundState.skippedCount,
    firstSequence: "1",
    lastSequence: (roundState.nextSequence - 1n).toString(),
    firstWinnerRank: 1,
    lastWinnerRank: WINNER_COUNT,
    rewardAmountBaseUnits: REWARD_AMOUNT.toString(),
    paidTotalBaseUnits: roundState.paidTotal.toString(),
    vaultBalanceBaseUnits: vaultState.amount.toString(),
    initialRecipientBalanceBaseUnits: initialTokenBalances
      .reduce((total, amount) => total + amount, 0n)
      .toString(),
    recipientBalanceBeforeCleanupBaseUnits: winnerTokenBalances
      .reduce((total, amount) => total + amount, 0n)
      .toString(),
    firstSubmittedAt: new Date(
      Math.min(...claimMeasurements.map((measurement) => measurement.sentAt)),
    ).toISOString(),
    firstConfirmedAt: new Date(
      Math.min(
        ...claimMeasurements.map((measurement) => measurement.confirmedAt),
      ),
    ).toISOString(),
    lastConfirmedAt: new Date(
      Math.max(
        ...claimMeasurements.map((measurement) => measurement.confirmedAt),
      ),
    ).toISOString(),
    roundOpenedAt: new Date(roundOpenedAt).toISOString(),
    drainDurationMs:
      Math.max(
        ...claimMeasurements.map((measurement) => measurement.confirmedAt),
      ) -
      Math.min(...claimMeasurements.map((measurement) => measurement.sentAt)),
    roundOpenToLastConfirmationMs:
      Math.max(
        ...claimMeasurements.map((measurement) => measurement.confirmedAt),
      ) - roundOpenedAt,
    confirmationLatencyMs: stats(claimLatencies),
    transactionBytes: stats(
      claimMeasurements.map((measurement) => measurement.bytes),
    ),
    computeUnits: stats(
      claimMeasurements.map((measurement) => measurement.units),
    ),
    simulationMode:
      "sequence-1-explicit-then-rpc-preflight-before-each-broadcast",
    rpcRetries: claimMeasurements.reduce(
      (total, measurement) => total + measurement.rpcRetries,
      0,
    ),
    firstSignature: signatures[0],
    lastSignature: signatures.at(-1),
    signatureCount: signatures.length,
    signaturesSha256: createHash("sha256")
      .update(signatures.join("\n"))
      .digest("hex"),
  },
  cleanup: Object.fromEntries(
    Object.entries(lifecycle).map(([key, measurement]) => [
      key,
      measurement.signature,
    ]),
  ),
  benchmarkWalletCleanup: {
    transferredAndClosed: walletCleanupMeasurements.length,
    recoveredTokenBaseUnits: winnerTokenBalances
      .reduce((total, amount) => total + amount, 0n)
      .toString(),
    tokenAccountsClosed: finalRecipientInfos.every((info) => info === null),
    transactionBytes: stats(
      walletCleanupMeasurements.map((measurement) => measurement.bytes),
    ),
    computeUnits: stats(
      walletCleanupMeasurements.map((measurement) => measurement.units),
    ),
  },
  invariantReadback: {
    registrations: registrationInfos.length,
    claims: claimInfos.length,
    recipientTokenAccounts: tokenInfos.length,
    contiguousSequences: true,
    contiguousWinnerRanks: true,
    exactTokenBalances: true,
    campaignFundedBaseUnits: finalCampaign.fundedAmount.toString(),
    campaignPaidBaseUnits: finalCampaign.paidAmount.toString(),
    campaignRefundedBaseUnits: finalCampaign.refundedAmount.toString(),
    vaultClosed: finalVaultInfo === null,
    fixtureSlotReleased: finalFixtureInfo === null,
  },
};

process.stdout.write(`BENCHMARK_RESULT=${stringify(result)}\n`);
for (const fan of fans) fan.secretKey.fill(0);

function claimIntent(fan: Keypair, nonce: Uint8Array, expiresAt: bigint) {
  return intentHash(
    canonicalizeIntent({
      programId: programId.toBytes(),
      action: IntentAction.Claim,
      campaign: campaign.toBytes(),
      round: round.toBytes(),
      wallet: fan.publicKey.toBytes(),
      nonce,
      expiresAt,
    }),
  );
}

function claimInstructions(
  index: number,
  sequence: bigint,
  nonce: Uint8Array,
  expiresAt: bigint,
  hash: Uint8Array,
): TransactionInstruction[] {
  const fan = fans[index]!;
  return [
    fanSignatureVerificationInstruction(
      fan.publicKey,
      hash,
      nacl.sign.detached(hash, fan.secretKey),
    ),
    settleClaimInstruction(
      programId,
      {
        config,
        campaign,
        round,
        wallet: fan.publicKey,
        registration: registrations[index]!,
        claim: claims[index]!,
        relayer: relayer.publicKey,
        feePayer: feePayer.publicKey,
        vault,
        rewardMint,
        recipientToken: recipientTokens[index]!,
      },
      { sequence, nonce, expiresAt, intentHash: hash },
    ),
  ];
}

async function sendPreflightMeasured(input: {
  label: string;
  instructions: readonly TransactionInstruction[];
  signers: Keypair[];
  computeUnits?: number;
  microLamports?: number;
}): Promise<Measurement> {
  let rpcRetries = 0;
  const latest = await recentBlockhash("processed", (retries) => {
    rpcRetries += retries;
  });
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest,
    instructions: input.instructions,
    compute: {
      units: input.computeUnits ?? 220_000,
      microLamports: input.microLamports ?? 1_000,
    },
  });
  transaction.sign(uniqueSigners(...input.signers));
  const bytes = assertTransactionSize(transaction);
  const signature = bs58.encode(transaction.signatures[0]!);
  const sentAt = Date.now();
  const returned = await sendChainedPreflight(
    transaction.serialize(),
    input.label,
    (retries) => {
      rpcRetries += retries;
    },
  );
  if (returned !== signature)
    throw new Error(`${input.label} returned an unexpected signature`);
  await delay(650);
  return {
    signature,
    bytes,
    units: 0,
    rpcRetries,
    sentAt,
    processedAt: 0,
    confirmedAt: 0,
  };
}

async function sendChainedPreflight(
  serialized: Uint8Array,
  label: string,
  recordRetries: (retries: number) => void,
): Promise<string> {
  let sequenceRetries = 0;
  for (;;) {
    try {
      return await rpc(
        () =>
          connection.sendRawTransaction(serialized, {
            maxRetries: 0,
            preflightCommitment: "processed",
            skipPreflight: false,
          }),
        `${label}: preflight and broadcast`,
        recordRetries,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        sequenceRetries >= 20 ||
        !/InvalidSequence|Claim sequence is not the next exact sequence|0x1785/i.test(
          message,
        )
      )
        throw error;
      sequenceRetries += 1;
      await delay(100);
    }
  }
}

async function trackClaimConfirmations(
  measurements: Measurement[],
  submissionComplete: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const signatures = measurements.map((measurement) => measurement.signature);
    const statuses = await rpc(
      () =>
        connection.getSignatureStatuses(signatures, {
          searchTransactionHistory: true,
        }),
      "claim confirmation tracker",
    );
    const observedAt = Date.now();
    for (const [index, status] of statuses.value.entries()) {
      if (status?.err)
        throw new Error(`claim ${index + 1} failed: ${stringify(status.err)}`);
      if (
        measurements[index]!.confirmedAt === 0 &&
        (status?.confirmationStatus === "confirmed" ||
          status?.confirmationStatus === "finalized")
      )
        measurements[index]!.confirmedAt = observedAt;
    }
    if (
      submissionComplete() &&
      measurements.every((measurement) => measurement.confirmedAt > 0)
    )
      return;
    await delay(1_000);
  }
  throw new Error("not all claim transactions reached confirmed");
}

async function readActualComputeUnits(signatures: string[]): Promise<number[]> {
  const units: number[] = [];
  for (let offset = 0; offset < signatures.length; offset += 4) {
    const batch = signatures.slice(offset, offset + 4);
    const transactions = await rpc(
      () =>
        connection.getTransactions(batch, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
      "read confirmed claim compute units",
    );
    for (const [index, transaction] of transactions.entries()) {
      const consumed = transaction?.meta?.computeUnitsConsumed;
      if (typeof consumed !== "number" || transaction?.meta?.err)
        throw new Error(`claim ${offset + index + 1} compute readback failed`);
      units.push(consumed);
    }
    await delay(1_100);
  }
  return units;
}

async function sendMeasured(input: {
  label: string;
  instructions: readonly TransactionInstruction[];
  signers: Keypair[];
  computeUnits?: number;
  microLamports?: number;
  simulationCommitment?: Commitment;
  confirmationCommitment?: Commitment;
}): Promise<Measurement> {
  const built = await buildSimulated(input);
  const sentAt = Date.now();
  await broadcast(built, input.label);
  const commitment = input.confirmationCommitment ?? "confirmed";
  const observed = await waitForCommitment(built, commitment);
  if (observed.error !== null)
    throw new Error(
      `${input.label} failed on chain: ${stringify(observed.error)}`,
    );
  return {
    signature: built.signature,
    bytes: built.bytes,
    units: built.units,
    rpcRetries: built.rpcRetries,
    sentAt,
    processedAt: observed.observedAt,
    confirmedAt: commitment === "processed" ? 0 : observed.observedAt,
  };
}

async function buildSimulated(input: {
  label: string;
  instructions: readonly TransactionInstruction[];
  signers: Keypair[];
  computeUnits?: number;
  microLamports?: number;
  simulationCommitment?: Commitment;
  expectSimulationFailure?: boolean;
}): Promise<BuiltTransaction> {
  let rpcRetries = 0;
  const latest = await recentBlockhash(
    input.simulationCommitment ?? "confirmed",
    (retries) => (rpcRetries += retries),
  );
  const transaction = buildSponsoredV0Transaction({
    feePayer: feePayer.publicKey,
    blockhash: latest,
    instructions: input.instructions,
    compute: {
      units: input.computeUnits ?? 220_000,
      microLamports: input.microLamports ?? 1_000,
    },
  });
  transaction.sign(uniqueSigners(...input.signers));
  const bytes = assertTransactionSize(transaction);
  const simulation = await rpc(
    () =>
      connection.simulateTransaction(transaction, {
        commitment: input.simulationCommitment ?? "confirmed",
        sigVerify: true,
      }),
    `${input.label}: simulation`,
    (retries) => (rpcRetries += retries),
  );
  if (input.expectSimulationFailure) {
    if (!simulation.value.err)
      throw new Error(`${input.label} simulation unexpectedly succeeded`);
    return {
      transaction,
      signature: bs58.encode(transaction.signatures[0]!),
      bytes,
      units: simulation.value.unitsConsumed ?? 0,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      rpcRetries,
      simulationRejected: true,
    };
  }
  if (simulation.value.err)
    throw new Error(
      `${input.label} simulation failed: ${stringify(simulation.value.err)}`,
    );
  return {
    transaction,
    signature: bs58.encode(transaction.signatures[0]!),
    bytes,
    units: simulation.value.unitsConsumed ?? 0,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    rpcRetries,
  };
}

async function broadcast(transaction: BuiltTransaction, label: string) {
  const returned = await rpc(
    () =>
      connection.sendRawTransaction(transaction.transaction.serialize(), {
        maxRetries: 5,
        skipPreflight: true,
      }),
    `${label}: broadcast`,
  );
  if (returned !== transaction.signature)
    throw new Error(`${label} returned an unexpected signature`);
}

async function waitForProcessed(transaction: BuiltTransaction): Promise<{
  signature: string;
  error: unknown | null;
  observedAt: number;
}> {
  try {
    return await waitForCommitment(transaction, "processed");
  } catch (error) {
    return {
      signature: transaction.signature,
      error,
      observedAt: Date.now(),
    };
  }
}

async function waitForCommitment(
  transaction: BuiltTransaction,
  commitment: Commitment,
): Promise<{
  signature: string;
  error: unknown | null;
  observedAt: number;
}> {
  const confirmation = await rpc(
    () =>
      connection.confirmTransaction(
        {
          signature: transaction.signature,
          blockhash: transaction.blockhash,
          lastValidBlockHeight: transaction.lastValidBlockHeight,
        },
        commitment,
      ),
    `confirm ${transaction.signature.slice(0, 8)}`,
  );
  return {
    signature: transaction.signature,
    error: confirmation.value.err,
    observedAt: Date.now(),
  };
}

async function recentBlockhash(
  commitment: Commitment,
  recordRetries?: (retries: number) => void,
): Promise<BlockhashWithExpiryBlockHeight> {
  if (cachedBlockhash && Date.now() - cachedBlockhash.fetchedAt < 20_000)
    return cachedBlockhash.value;
  const value = await rpc(
    () => connection.getLatestBlockhash(commitment),
    "latest blockhash",
    recordRetries,
  );
  cachedBlockhash = { value, fetchedAt: Date.now() };
  return value;
}

async function rpc<T>(
  operation: () => Promise<T>,
  _label: string,
  recordRetries?: (retries: number) => void,
): Promise<T> {
  let retries = 0;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    try {
      const result = await operation();
      recordRetries?.(retries);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 8 ||
        !/429|Too Many Requests|timed out|timeout|fetch failed|ECONN|block height exceeded/i.test(
          message,
        )
      )
        throw error;
      retries += 1;
      totalRpcRetries += 1;
      await delay(Math.min(4_000, 250 * 2 ** attempt));
    }
  }
  throw new Error("RPC operation exhausted retries");
}

async function concurrentMap<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await worker(values[index]!, index);
      }
    }),
  );
  return output;
}

function uniqueSigners(...signers: Keypair[]): Keypair[] {
  return signers.filter(
    (signer, index) =>
      signers.findIndex((candidate) =>
        candidate.publicKey.equals(signer.publicKey),
      ) === index,
  );
}

function digest32(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ]!;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertDevnetEndpoint(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /mainnet/i.test(url.hostname)
  )
    throw new Error("benchmark RPC must be an HTTPS Devnet endpoint");
}

function safeEndpoint(value: string): string {
  const url = new URL(value);
  const publicEndpoint =
    url.search === "" &&
    [
      "api.devnet.solana.com",
      "explorer-api.devnet.solana.com",
      "solana-devnet.api.onfinality.io",
    ].includes(url.hostname);
  return publicEndpoint ? value : `${url.origin}/[credential-redacted]`;
}

import { PublicKey } from "@solana/web3.js";
import { CampaignState, RoundSource, RoundState } from "@goaldrop/protocol";

function expectLength(data: Buffer, length: number, account: string): void {
  if (data.length !== length)
    throw new Error(
      `${account} must be ${length} bytes; received ${data.length}`,
    );
}

export interface PlatformConfigAccount {
  version: number;
  bump: number;
  pauseMask: number;
  authorityEpoch: number;
  admin: PublicKey;
  oracle: PublicKey;
  relayer: PublicKey;
  demoAuthority: PublicKey;
  rewardMint: PublicKey;
  networkDomain: Uint8Array;
  rewardDecimals: number;
}

export function decodePlatformConfigAccount(
  data: Buffer,
): PlatformConfigAccount {
  expectLength(data, 240, "PlatformConfig");
  return {
    version: data[8] ?? 0,
    bump: data[9] ?? 0,
    pauseMask: data.readUInt16LE(10),
    authorityEpoch: data.readUInt32LE(12),
    admin: new PublicKey(data.subarray(16, 48)),
    oracle: new PublicKey(data.subarray(48, 80)),
    relayer: new PublicKey(data.subarray(80, 112)),
    demoAuthority: new PublicKey(data.subarray(112, 144)),
    rewardMint: new PublicKey(data.subarray(144, 176)),
    networkDomain: new Uint8Array(data.subarray(176, 208)),
    rewardDecimals: data[208] ?? 0,
  };
}

export interface CampaignAccount {
  version: number;
  bump: number;
  vaultBump: number;
  state: number;
  roundCount: number;
  nextRound: number;
  openRoundCount: number;
  terminalReason: number;
  sponsor: PublicKey;
  fixtureSlot: PublicKey;
  fixtureId: bigint;
  rewardMint: PublicKey;
  refundWallet: PublicKey;
  scheduledStart: bigint;
  registrationDeadline: bigint;
  expectedEnd: bigint;
  hardExpiry: bigint;
  campaignNonce: bigint;
  requiredFunding: bigint;
  fundedAmount: bigint;
  paidAmount: bigint;
  refundedAmount: bigint;
  createdAt: bigint;
  activatedAt: bigint;
  matchCompleteAt: bigint;
  externalInflowTotal: bigint;
  rounds: { rewardAmount: bigint; winnerCap: number }[];
}

export function decodeCampaignAccount(data: Buffer): CampaignAccount {
  expectLength(data, 424, "Campaign");
  return {
    version: data[8] ?? 0,
    bump: data[9] ?? 0,
    vaultBump: data[10] ?? 0,
    state: data[11] ?? CampaignState.Draft,
    roundCount: data[12] ?? 0,
    nextRound: data[13] ?? 0,
    openRoundCount: data[14] ?? 0,
    terminalReason: data[15] ?? 0,
    sponsor: new PublicKey(data.subarray(16, 48)),
    fixtureSlot: new PublicKey(data.subarray(48, 80)),
    fixtureId: data.readBigUInt64LE(80),
    rewardMint: new PublicKey(data.subarray(88, 120)),
    refundWallet: new PublicKey(data.subarray(120, 152)),
    scheduledStart: data.readBigInt64LE(152),
    registrationDeadline: data.readBigInt64LE(160),
    expectedEnd: data.readBigInt64LE(168),
    hardExpiry: data.readBigInt64LE(176),
    createdAt: data.readBigInt64LE(184),
    activatedAt: data.readBigInt64LE(192),
    matchCompleteAt: data.readBigInt64LE(200),
    campaignNonce: data.readBigUInt64LE(208),
    requiredFunding: data.readBigUInt64LE(216),
    fundedAmount: data.readBigUInt64LE(224),
    paidAmount: data.readBigUInt64LE(232),
    refundedAmount: data.readBigUInt64LE(240),
    externalInflowTotal:
      data.readBigUInt64LE(248) + (data.readBigUInt64LE(256) << 64n),
    rounds: Array.from({ length: data[12] ?? 0 }, (_, index) => ({
      rewardAmount: data.readBigUInt64LE(264 + index * 16),
      winnerCap: data.readUInt16LE(272 + index * 16),
    })),
  };
}

export interface RegistrationAccount {
  version: number;
  bump: number;
  campaign: PublicKey;
  wallet: PublicKey;
  registeredAt: bigint;
  intentHash: Uint8Array;
}

export function decodeRegistrationAccount(data: Buffer): RegistrationAccount {
  expectLength(data, 128, "Registration");
  return {
    version: data[8] ?? 0,
    bump: data[9] ?? 0,
    campaign: new PublicKey(data.subarray(10, 42)),
    wallet: new PublicKey(data.subarray(42, 74)),
    registeredAt: data.readBigInt64LE(74),
    intentHash: new Uint8Array(data.subarray(82, 114)),
  };
}

export interface ClaimAccount {
  version: number;
  bump: number;
  winnerRank: number;
  campaign: PublicKey;
  round: PublicKey;
  wallet: PublicKey;
  recipient: PublicKey;
  sequence: bigint;
  amount: bigint;
  paidAt: bigint;
  intentHash: Uint8Array;
}

export function decodeClaimAccount(data: Buffer): ClaimAccount {
  expectLength(data, 200, "Claim");
  return {
    version: data[8] ?? 0,
    bump: data[9] ?? 0,
    winnerRank: data.readUInt16LE(10),
    campaign: new PublicKey(data.subarray(12, 44)),
    round: new PublicKey(data.subarray(44, 76)),
    wallet: new PublicKey(data.subarray(76, 108)),
    recipient: new PublicKey(data.subarray(108, 140)),
    sequence: data.readBigUInt64LE(140),
    amount: data.readBigUInt64LE(148),
    paidAt: data.readBigInt64LE(156),
    intentHash: new Uint8Array(data.subarray(164, 196)),
  };
}

export interface RoundAccount {
  version: number;
  bump: number;
  state: number;
  source: number;
  ordinal: number;
  campaign: PublicKey;
  goalReceipt: PublicKey;
  eventHash: Uint8Array;
  providerActionId: bigint;
  providerSeq: number;
  providerStatus: number;
  providerTsMs: bigint;
  openedAt: bigint;
  closesAt: bigint;
  rewardAmount: bigint;
  winnerCap: number;
  winnerCount: number;
  nextSequence: bigint;
  skippedCount: number;
  paidTotal: bigint;
}

export function decodeRoundAccount(data: Buffer): RoundAccount {
  expectLength(data, 216, "Round");
  return {
    version: data[8] ?? 0,
    bump: data[9] ?? 0,
    state: data[10] ?? RoundState.Open,
    source: data[11] ?? RoundSource.Live,
    ordinal: data[12] ?? 0,
    campaign: new PublicKey(data.subarray(16, 48)),
    goalReceipt: new PublicKey(data.subarray(48, 80)),
    eventHash: new Uint8Array(data.subarray(80, 112)),
    providerActionId: data.readBigUInt64LE(112),
    providerSeq: data.readUInt32LE(120),
    providerStatus: data.readUInt16LE(124),
    providerTsMs: data.readBigInt64LE(128),
    openedAt: data.readBigInt64LE(136),
    closesAt: data.readBigInt64LE(144),
    rewardAmount: data.readBigUInt64LE(152),
    winnerCap: data.readUInt16LE(160),
    winnerCount: data.readUInt16LE(162),
    nextSequence: data.readBigUInt64LE(164),
    skippedCount: data.readUInt32LE(172),
    paidTotal: data.readBigUInt64LE(176),
  };
}

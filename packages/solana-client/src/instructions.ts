import {
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  type PublicKey,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  anchorDiscriminator,
  concat,
  fixed,
  i64,
  u8,
  u16,
  u32,
  u64,
} from "./codec.js";

function instruction(
  programId: PublicKey,
  name: string,
  keys: ConstructorParameters<typeof TransactionInstruction>[0]["keys"],
  args?: Uint8Array,
) {
  return new TransactionInstruction({
    programId,
    keys,
    data: concat(anchorDiscriminator("global", name), args ?? new Uint8Array()),
  });
}

export interface CampaignRoundConfig {
  rewardAmount: bigint;
  winnerCap: number;
}

export function initializeConfigInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    admin: PublicKey;
    rewardMint: PublicKey;
  },
  fields: {
    oracle: PublicKey;
    relayer: PublicKey;
    demoAuthority: PublicKey;
    networkDomain: Uint8Array;
    rewardDecimals: number;
  },
): TransactionInstruction {
  return instruction(
    programId,
    "initialize_config",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: true },
      { pubkey: accounts.admin, isSigner: true, isWritable: true },
      { pubkey: accounts.rewardMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(
      fields.oracle.toBytes(),
      fields.relayer.toBytes(),
      fields.demoAuthority.toBytes(),
      fixed(fields.networkDomain, 32, "network domain"),
      u8(fields.rewardDecimals),
    ),
  );
}

export function setPauseMaskInstruction(
  programId: PublicKey,
  config: PublicKey,
  admin: PublicKey,
  pauseMask: number,
): TransactionInstruction {
  return instruction(
    programId,
    "set_pause_mask",
    [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
    ],
    u16(pauseMask),
  );
}

export function rotateAuthorityInstruction(
  programId: PublicKey,
  config: PublicKey,
  admin: PublicKey,
  role: number,
  authority: PublicKey,
): TransactionInstruction {
  return instruction(
    programId,
    "rotate_authority",
    [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
    ],
    concat(u8(role), authority.toBytes()),
  );
}

export interface CreateCampaignFields {
  fixtureId: bigint;
  campaignNonce: bigint;
  scheduledStart: bigint;
  registrationDeadline: bigint;
  expectedEnd: bigint;
  hardExpiry: bigint;
  rounds: readonly CampaignRoundConfig[];
}

export function createCampaignInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    sponsor: PublicKey;
    feePayer: PublicKey;
    refundWallet: PublicKey;
    rewardMint: PublicKey;
    fixtureSlot: PublicKey;
    campaign: PublicKey;
    vault: PublicKey;
  },
  fields: CreateCampaignFields,
): TransactionInstruction {
  if (fields.rounds.length < 1 || fields.rounds.length > 8)
    throw new RangeError("campaign must have 1 to 8 rounds");
  const rounds = Array.from({ length: 8 }, (_, index) => {
    const round = fields.rounds[index];
    return round
      ? concat(u64(round.rewardAmount), u16(round.winnerCap), new Uint8Array(6))
      : new Uint8Array(16);
  });
  return instruction(
    programId,
    "create_campaign",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.sponsor, isSigner: true, isWritable: false },
      { pubkey: accounts.feePayer, isSigner: true, isWritable: true },
      { pubkey: accounts.refundWallet, isSigner: false, isWritable: false },
      { pubkey: accounts.rewardMint, isSigner: false, isWritable: false },
      { pubkey: accounts.fixtureSlot, isSigner: false, isWritable: true },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    concat(
      u64(fields.fixtureId),
      u64(fields.campaignNonce),
      i64(fields.scheduledStart),
      i64(fields.registrationDeadline),
      i64(fields.expectedEnd),
      i64(fields.hardExpiry),
      u8(fields.rounds.length),
      ...rounds,
    ),
  );
}

export function fundCampaignInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    sponsor: PublicKey;
    campaign: PublicKey;
    sponsorSource: PublicKey;
    rewardMint: PublicKey;
    vault: PublicKey;
  },
  amount: bigint,
): TransactionInstruction {
  return instruction(
    programId,
    "fund_campaign",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.sponsor, isSigner: true, isWritable: true },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.sponsorSource, isSigner: false, isWritable: true },
      { pubkey: accounts.rewardMint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    u64(amount),
  );
}

export function sponsorCampaignInstruction(
  programId: PublicKey,
  action: "activate_campaign" | "cancel_campaign",
  accounts: {
    config: PublicKey;
    sponsor: PublicKey;
    campaign: PublicKey;
    vault: PublicKey;
  },
): TransactionInstruction {
  return instruction(programId, action, [
    { pubkey: accounts.config, isSigner: false, isWritable: false },
    { pubkey: accounts.sponsor, isSigner: true, isWritable: false },
    { pubkey: accounts.campaign, isSigner: false, isWritable: true },
    { pubkey: accounts.vault, isSigner: false, isWritable: false },
  ]);
}

export function finalizeAfterTimeoutInstruction(
  programId: PublicKey,
  campaign: PublicKey,
): TransactionInstruction {
  return instruction(programId, "finalize_after_timeout", [
    { pubkey: campaign, isSigner: false, isWritable: true },
  ]);
}

export function makeRefundableInstruction(
  programId: PublicKey,
  campaign: PublicKey,
  vault: PublicKey,
): TransactionInstruction {
  return instruction(programId, "make_refundable", [
    { pubkey: campaign, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: false },
  ]);
}

export function refundCampaignInstruction(
  programId: PublicKey,
  accounts: {
    campaign: PublicKey;
    vault: PublicKey;
    rewardMint: PublicKey;
    refundWallet: PublicKey;
    refundToken: PublicKey;
  },
): TransactionInstruction {
  return instruction(programId, "refund_campaign", [
    { pubkey: accounts.campaign, isSigner: false, isWritable: true },
    { pubkey: accounts.vault, isSigner: false, isWritable: true },
    { pubkey: accounts.rewardMint, isSigner: false, isWritable: false },
    { pubkey: accounts.refundWallet, isSigner: false, isWritable: true },
    { pubkey: accounts.refundToken, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ]);
}

export function releaseFixtureSlotInstruction(
  programId: PublicKey,
  accounts: {
    campaign: PublicKey;
    fixtureSlot: PublicKey;
    rentRecipient: PublicKey;
  },
): TransactionInstruction {
  return instruction(programId, "release_fixture_slot", [
    { pubkey: accounts.campaign, isSigner: false, isWritable: false },
    { pubkey: accounts.fixtureSlot, isSigner: false, isWritable: true },
    { pubkey: accounts.rentRecipient, isSigner: false, isWritable: true },
  ]);
}

export interface OpenLiveRoundAccounts {
  config: PublicKey;
  oracle: PublicKey;
  feePayer: PublicKey;
  campaign: PublicKey;
  round: PublicKey;
  goalReceipt: PublicKey;
}
export interface OpenLiveRoundFields {
  fixtureId: bigint;
  eventHash: Uint8Array;
  providerActionId: bigint;
  providerSeq: number;
  providerStatus: number;
  confirmedAtOpen: boolean;
  providerTsMs: bigint;
  rawDigest: Uint8Array;
}

export function openLiveRoundInstruction(
  programId: PublicKey,
  accounts: OpenLiveRoundAccounts,
  fields: OpenLiveRoundFields,
): TransactionInstruction {
  return instruction(
    programId,
    "open_live_round",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.oracle, isSigner: true, isWritable: false },
      { pubkey: accounts.feePayer, isSigner: true, isWritable: true },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.round, isSigner: false, isWritable: true },
      { pubkey: accounts.goalReceipt, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(
      u64(fields.fixtureId),
      fixed(fields.eventHash, 32, "event hash"),
      u64(fields.providerActionId),
      u32(fields.providerSeq),
      u16(fields.providerStatus),
      u8(fields.confirmedAtOpen ? 1 : 0),
      i64(fields.providerTsMs),
      fixed(fields.rawDigest, 32, "raw digest"),
    ),
  );
}

export function openDemoRoundInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    demoAuthority: PublicKey;
    feePayer: PublicKey;
    campaign: PublicKey;
    round: PublicKey;
    goalReceipt: PublicKey;
  },
  fields: {
    fixtureId: bigint;
    eventHash: Uint8Array;
    demoNonce: bigint;
    providerTsMs: bigint;
    rawDigest: Uint8Array;
  },
): TransactionInstruction {
  return instruction(
    programId,
    "open_demo_round",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.demoAuthority, isSigner: true, isWritable: false },
      { pubkey: accounts.feePayer, isSigner: true, isWritable: true },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.round, isSigner: false, isWritable: true },
      { pubkey: accounts.goalReceipt, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(
      u64(fields.fixtureId),
      fixed(fields.eventHash, 32, "event hash"),
      u64(fields.demoNonce),
      i64(fields.providerTsMs),
      fixed(fields.rawDigest, 32, "raw digest"),
    ),
  );
}

export function registerFanInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    campaign: PublicKey;
    wallet: PublicKey;
    registration: PublicKey;
    relayer: PublicKey;
    feePayer: PublicKey;
  },
  fields: { nonce: Uint8Array; expiresAt: bigint; intentHash: Uint8Array },
): TransactionInstruction {
  return instruction(
    programId,
    "register_fan",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.campaign, isSigner: false, isWritable: false },
      { pubkey: accounts.wallet, isSigner: false, isWritable: false },
      { pubkey: accounts.registration, isSigner: false, isWritable: true },
      { pubkey: accounts.relayer, isSigner: true, isWritable: false },
      { pubkey: accounts.feePayer, isSigner: true, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(
      fixed(fields.nonce, 16, "nonce"),
      i64(fields.expiresAt),
      fixed(fields.intentHash, 32, "intent hash"),
    ),
  );
}

export function settleClaimInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    campaign: PublicKey;
    round: PublicKey;
    wallet: PublicKey;
    registration: PublicKey;
    claim: PublicKey;
    relayer: PublicKey;
    feePayer: PublicKey;
    vault: PublicKey;
    rewardMint: PublicKey;
    recipientToken: PublicKey;
  },
  fields: {
    sequence: bigint;
    nonce: Uint8Array;
    expiresAt: bigint;
    intentHash: Uint8Array;
  },
): TransactionInstruction {
  return instruction(
    programId,
    "settle_claim",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.round, isSigner: false, isWritable: true },
      { pubkey: accounts.wallet, isSigner: false, isWritable: false },
      { pubkey: accounts.wallet, isSigner: false, isWritable: false },
      { pubkey: accounts.registration, isSigner: false, isWritable: false },
      { pubkey: accounts.claim, isSigner: false, isWritable: true },
      { pubkey: accounts.relayer, isSigner: true, isWritable: false },
      { pubkey: accounts.feePayer, isSigner: true, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.rewardMint, isSigner: false, isWritable: false },
      { pubkey: accounts.recipientToken, isSigner: false, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    concat(
      u64(fields.sequence),
      fixed(fields.nonce, 16, "nonce"),
      i64(fields.expiresAt),
      fixed(fields.intentHash, 32, "intent hash"),
    ),
  );
}

export function skipSequenceInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    campaign: PublicKey;
    round: PublicKey;
    relayer: PublicKey;
  },
  fields: { sequence: bigint; intentHash: Uint8Array; reason: number },
): TransactionInstruction {
  return instruction(
    programId,
    "skip_sequence",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.campaign, isSigner: false, isWritable: false },
      { pubkey: accounts.round, isSigner: false, isWritable: true },
      { pubkey: accounts.relayer, isSigner: true, isWritable: false },
    ],
    concat(
      u64(fields.sequence),
      fixed(fields.intentHash, 32, "intent hash"),
      u8(fields.reason),
    ),
  );
}

export function closeRoundInstruction(
  programId: PublicKey,
  campaign: PublicKey,
  round: PublicKey,
): TransactionInstruction {
  return instruction(programId, "close_round", [
    { pubkey: campaign, isSigner: false, isWritable: true },
    { pubkey: round, isSigner: false, isWritable: true },
  ]);
}

export function markMatchCompleteInstruction(
  programId: PublicKey,
  accounts: {
    config: PublicKey;
    campaign: PublicKey;
    oracle: PublicKey;
  },
  fields: {
    terminalReason: number;
    providerActionId: bigint;
    providerSeq: number;
  },
): TransactionInstruction {
  return instruction(
    programId,
    "mark_match_complete",
    [
      { pubkey: accounts.config, isSigner: false, isWritable: false },
      { pubkey: accounts.campaign, isSigner: false, isWritable: true },
      { pubkey: accounts.oracle, isSigner: true, isWritable: false },
    ],
    concat(
      u8(fields.terminalReason),
      u64(fields.providerActionId),
      u32(fields.providerSeq),
    ),
  );
}

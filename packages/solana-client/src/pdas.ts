import { PublicKey } from "@solana/web3.js";

const CONFIG_SEED = Buffer.from("config");
const FIXTURE_SEED = Buffer.from("fixture");
const CAMPAIGN_SEED = Buffer.from("campaign");
const VAULT_SEED = Buffer.from("vault");
const ROUND_SEED = Buffer.from("round");
const GOAL_SEED = Buffer.from("goal");
const REGISTRATION_SEED = Buffer.from("registration");
const CLAIM_SEED = Buffer.from("claim");

function u64Le(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new RangeError("u64 seed out of range");
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value);
  return output;
}

export function configPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

export function fixtureSlotPda(
  programId: PublicKey,
  fixtureId: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FIXTURE_SEED, u64Le(fixtureId)],
    programId,
  );
}

export function campaignPda(
  programId: PublicKey,
  sponsor: PublicKey,
  campaignNonce: bigint,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CAMPAIGN_SEED, sponsor.toBuffer(), u64Le(campaignNonce)],
    programId,
  );
}

export function vaultPda(
  programId: PublicKey,
  campaign: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, campaign.toBuffer()],
    programId,
  );
}

export function roundPda(
  programId: PublicKey,
  campaign: PublicKey,
  ordinal: number,
): [PublicKey, number] {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 7)
    throw new RangeError("round ordinal out of range");
  return PublicKey.findProgramAddressSync(
    [ROUND_SEED, campaign.toBuffer(), Buffer.from([ordinal])],
    programId,
  );
}

export function goalReceiptPda(
  programId: PublicKey,
  campaign: PublicKey,
  eventHash: Uint8Array,
): [PublicKey, number] {
  if (eventHash.length !== 32)
    throw new RangeError("event hash must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [GOAL_SEED, campaign.toBuffer(), Buffer.from(eventHash)],
    programId,
  );
}

export function registrationPda(
  programId: PublicKey,
  campaign: PublicKey,
  wallet: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REGISTRATION_SEED, campaign.toBuffer(), wallet.toBuffer()],
    programId,
  );
}

export function claimPda(
  programId: PublicKey,
  round: PublicKey,
  wallet: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CLAIM_SEED, round.toBuffer(), wallet.toBuffer()],
    programId,
  );
}

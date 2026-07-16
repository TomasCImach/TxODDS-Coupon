use anchor_lang::prelude::*;

#[error_code]
pub enum GoalDropError {
    #[msg("Platform operation is paused")]
    Paused,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Authority role is invalid")]
    InvalidAuthorityRole,
    #[msg("Pause mask contains undefined bits")]
    InvalidPauseMask,
    #[msg("Campaign state does not permit this operation")]
    InvalidCampaignState,
    #[msg("Round state does not permit this operation")]
    InvalidRoundState,
    #[msg("Campaign time bounds are invalid")]
    InvalidTimeBounds,
    #[msg("Campaign round configuration is invalid")]
    InvalidRoundConfig,
    #[msg("Campaign funding calculation overflowed")]
    FundingOverflow,
    #[msg("Funding amount must exactly equal required funding")]
    InvalidFundingAmount,
    #[msg("Reward mint or decimals do not match platform configuration")]
    InvalidRewardMint,
    #[msg("Fixture metadata does not match campaign")]
    InvalidFixture,
    #[msg("Campaign registration deadline has passed")]
    RegistrationClosed,
    #[msg("Campaign is terminal or hard-expired")]
    CampaignTerminal,
    #[msg("No configured reward round remains")]
    NoRoundsRemaining,
    #[msg("Intent has expired")]
    IntentExpired,
    #[msg("Intent digest does not match canonical fields")]
    InvalidIntentHash,
    #[msg("Expected an immediately preceding Ed25519 verification instruction")]
    MissingEd25519Instruction,
    #[msg("Ed25519 instruction layout is invalid or references another instruction")]
    InvalidEd25519Instruction,
    #[msg("Ed25519 public key or message does not match the intent")]
    Ed25519IntentMismatch,
    #[msg("Recipient must be the fan wallet")]
    RecipientMismatch,
    #[msg("Claim sequence is not the next exact sequence")]
    InvalidSequence,
    #[msg("Round claim window has expired")]
    RoundExpired,
    #[msg("Round winner cap has been reached")]
    WinnerCapReached,
    #[msg("Skip reason is not a bounded protocol value")]
    InvalidSkipReason,
    #[msg("Vault balance is below recorded accounting")]
    VaultAccountingDeficit,
    #[msg("Token accounting overflowed")]
    AccountingOverflow,
    #[msg("Token destination is not the canonical classic ATA")]
    InvalidTokenDestination,
    #[msg("Campaign still has an open round")]
    OpenRoundsRemain,
    #[msg("Campaign is not terminal")]
    CampaignNotTerminal,
    #[msg("Refund destination does not match immutable campaign wallet")]
    InvalidRefundDestination,
    #[msg("Fixture slot does not belong to campaign")]
    InvalidFixtureSlot,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}

use anchor_lang::prelude::*;

pub const PROGRAM_VERSION: u8 = 1;
pub const MAX_ROUNDS: usize = 8;
pub const ROUND_DURATION_SECONDS: i64 = 120;
pub const MAX_WINNERS_PER_ROUND: u16 = 100;
pub const MAX_REWARD_AMOUNT: u64 = 1_000_000_000_000;
pub const MAX_HARD_EXPIRY_SECONDS: i64 = 24 * 60 * 60;
pub const DEVNET_NETWORK_DOMAIN: [u8; 32] = [
    125, 187, 141, 242, 206, 231, 24, 65, 161, 243, 176, 72, 161, 109, 123, 35, 76, 20, 232, 133,
    115, 171, 123, 131, 101, 214, 197, 231, 226, 76, 122, 7,
];

pub const PAUSE_CAMPAIGN_WRITES: u16 = 0x0001;
pub const PAUSE_REGISTRATION: u16 = 0x0002;
pub const PAUSE_ROUND_OPEN: u16 = 0x0004;
pub const PAUSE_SETTLEMENT: u16 = 0x0008;
pub const VALID_PAUSE_MASK: u16 =
    PAUSE_CAMPAIGN_WRITES | PAUSE_REGISTRATION | PAUSE_ROUND_OPEN | PAUSE_SETTLEMENT;

pub mod campaign_state {
    pub const DRAFT: u8 = 0;
    pub const FUNDED: u8 = 1;
    pub const ACTIVE: u8 = 2;
    pub const CANCELLED: u8 = 3;
    pub const REFUNDABLE: u8 = 4;
    pub const REFUNDED: u8 = 5;
}

pub mod terminal_reason {
    pub const NONE: u8 = 0;
    pub const PROVIDER_FINALISED: u8 = 1;
    pub const PROVIDER_CANCELLED: u8 = 2;
    pub const PROVIDER_ABANDONED: u8 = 3;
    pub const HARD_TIMEOUT: u8 = 4;
}

pub mod round_state {
    pub const OPEN: u8 = 0;
    pub const EXHAUSTED: u8 = 1;
    pub const EXPIRED: u8 = 2;
}

pub mod round_source {
    pub const LIVE: u8 = 0;
    pub const DEMO: u8 = 1;
}

pub mod skip_reason {
    pub const INVALID_AFTER_ACCEPTANCE: u8 = 1;
    pub const RECIPIENT_ACCOUNT_FAILURE: u8 = 2;
    pub const PERMANENT_PROGRAM_MISMATCH: u8 = 3;
    pub const OPERATOR_INCIDENT: u8 = 255;
}

#[account]
pub struct PlatformConfig {
    pub version: u8,
    pub bump: u8,
    pub pause_mask: u16,
    pub authority_epoch: u32,
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub relayer: Pubkey,
    pub demo_authority: Pubkey,
    pub reward_mint: Pubkey,
    pub network_domain: [u8; 32],
    pub reward_decimals: u8,
    pub reserved: [u8; 31],
}
impl PlatformConfig {
    pub const SPACE: usize = 8 + 232;
}

#[account]
pub struct FixtureSlot {
    pub bump: u8,
    pub fixture_id: u64,
    pub campaign: Pubkey,
    pub reserved_at: i64,
    pub reserved: [u8; 15],
}
impl FixtureSlot {
    pub const SPACE: usize = 8 + 64;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct RoundConfig {
    pub reward_amount: u64,
    pub winner_cap: u16,
    pub reserved: [u8; 6],
}
impl RoundConfig {
    pub const DATA_LEN: usize = 16;
}

#[account]
pub struct Campaign {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub state: u8,
    pub round_count: u8,
    pub next_round: u8,
    pub open_round_count: u8,
    pub terminal_reason: u8,
    pub sponsor: Pubkey,
    pub fixture_slot: Pubkey,
    pub fixture_id: u64,
    pub reward_mint: Pubkey,
    pub refund_wallet: Pubkey,
    pub scheduled_start: i64,
    pub registration_deadline: i64,
    pub expected_end: i64,
    pub hard_expiry: i64,
    pub created_at: i64,
    pub activated_at: i64,
    pub match_complete_at: i64,
    pub campaign_nonce: u64,
    pub required_funding: u64,
    pub funded_amount: u64,
    pub paid_amount: u64,
    pub refunded_amount: u64,
    pub external_inflow_total: u128,
    pub rounds: [RoundConfig; MAX_ROUNDS],
    pub reserved: [u8; 32],
}
impl Campaign {
    pub const SPACE: usize = 8 + 416;
}

#[account]
pub struct Round {
    pub version: u8,
    pub bump: u8,
    pub state: u8,
    pub source: u8,
    pub ordinal: u8,
    pub reserved_header: [u8; 3],
    pub campaign: Pubkey,
    pub goal_receipt: Pubkey,
    pub event_hash: [u8; 32],
    pub provider_action_id: u64,
    pub provider_seq: u32,
    pub provider_status: u16,
    pub reserved_provider: [u8; 2],
    pub provider_ts_ms: i64,
    pub opened_at: i64,
    pub closes_at: i64,
    pub reward_amount: u64,
    pub winner_cap: u16,
    pub winner_count: u16,
    pub next_sequence: u64,
    pub skipped_count: u32,
    pub paid_total: u64,
    pub reserved: [u8; 32],
}
impl Round {
    pub const SPACE: usize = 8 + 208;
}

#[account]
pub struct GoalReceipt {
    pub version: u8,
    pub bump: u8,
    pub source: u8,
    pub round_ordinal: u8,
    pub campaign: Pubkey,
    pub event_hash: [u8; 32],
    pub provider_action_id: u64,
    pub provider_seq: u32,
    pub provider_status: u16,
    pub confirmed_at_open: u8,
    pub reserved_header: u8,
    pub provider_ts_ms: i64,
    pub opened_at: i64,
    pub raw_digest: [u8; 32],
    pub reserved: [u8; 28],
}
impl GoalReceipt {
    pub const SPACE: usize = 8 + 160;
}

#[account]
pub struct Registration {
    pub version: u8,
    pub bump: u8,
    pub campaign: Pubkey,
    pub wallet: Pubkey,
    pub registered_at: i64,
    pub intent_hash: [u8; 32],
    pub reserved: [u8; 14],
}
impl Registration {
    pub const SPACE: usize = 8 + 120;
}

#[account]
pub struct Claim {
    pub version: u8,
    pub bump: u8,
    pub winner_rank: u16,
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub recipient: Pubkey,
    pub sequence: u64,
    pub amount: u64,
    pub paid_at: i64,
    pub intent_hash: [u8; 32],
    pub reserved: [u8; 4],
}
impl Claim {
    pub const SPACE: usize = 8 + 192;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_space_budgets_match_the_protocol() {
        assert_eq!(PlatformConfig::SPACE, 240);
        assert_eq!(FixtureSlot::SPACE, 72);
        assert_eq!(RoundConfig::DATA_LEN, 16);
        assert_eq!(Campaign::SPACE, 424);
        assert_eq!(Round::SPACE, 216);
        assert_eq!(GoalReceipt::SPACE, 168);
        assert_eq!(Registration::SPACE, 128);
        assert_eq!(Claim::SPACE, 200);
    }
}

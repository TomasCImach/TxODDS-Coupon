use anchor_lang::prelude::*;

#[event]
pub struct CampaignCreated {
    pub version: u8,
    pub campaign: Pubkey,
    pub fixture_id: u64,
    pub sponsor: Pubkey,
    pub mint: Pubkey,
    pub required_funding: u64,
    pub round_count: u8,
}
#[event]
pub struct CampaignFunded {
    pub campaign: Pubkey,
    pub deposited_amount: u64,
    pub vault: Pubkey,
}
#[event]
pub struct CampaignActivated {
    pub campaign: Pubkey,
    pub activated_at: i64,
    pub registration_deadline: i64,
    pub hard_expiry: i64,
}
#[event]
pub struct FanRegistered {
    pub campaign: Pubkey,
    pub wallet: Pubkey,
    pub registered_at: i64,
    pub intent_hash: [u8; 32],
}
#[event]
pub struct RoundOpened {
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub ordinal: u8,
    pub source: u8,
    pub event_hash: [u8; 32],
    pub opened_at: i64,
    pub closes_at: i64,
    pub reward_amount: u64,
    pub winner_cap: u16,
}
#[event]
pub struct ClaimPaid {
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub sequence: u64,
    pub winner_rank: u16,
    pub amount: u64,
    pub intent_hash: [u8; 32],
}
#[event]
pub struct SequenceSkipped {
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub sequence: u64,
    pub intent_hash: [u8; 32],
    pub reason: u8,
}
#[event]
pub struct RoundClosed {
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub state: u8,
    pub winners: u16,
    pub paid_total: u64,
    pub skipped_count: u32,
}
#[event]
pub struct MatchCompleted {
    pub campaign: Pubkey,
    pub terminal_reason: u8,
    pub provider_action_id: u64,
    pub provider_seq: u32,
    pub completed_at: i64,
}
#[event]
pub struct CampaignRefundable {
    pub campaign: Pubkey,
    pub paid_amount: u64,
    pub residual_balance: u64,
}
#[event]
pub struct CampaignRefunded {
    pub campaign: Pubkey,
    pub refund_wallet: Pubkey,
    pub token_amount: u64,
    pub vault_closure_recipient: Pubkey,
}
#[event]
pub struct AuthorityRotated {
    pub authority_epoch: u32,
    pub role: u8,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
#[event]
pub struct PauseChanged {
    pub authority_epoch: u32,
    pub old_mask: u16,
    pub new_mask: u16,
}

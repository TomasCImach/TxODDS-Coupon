use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions;
use solana_sdk_ids::ed25519_program;
use solana_sha256_hasher::hash;

use crate::errors::GoalDropError;
use crate::state::PlatformConfig;

pub const INTENT_DOMAIN_TAG: [u8; 16] = *b"GOALDROP_V1\0\0\0\0\0";
pub const REGISTER_ACTION: u8 = 1;
pub const CLAIM_ACTION: u8 = 2;
pub const CANONICAL_INTENT_LENGTH: usize = 233;

pub struct IntentFields {
    pub action: u8,
    pub campaign: Pubkey,
    pub round: Pubkey,
    pub wallet: Pubkey,
    pub recipient: Pubkey,
    pub nonce: [u8; 16],
    pub expires_at: i64,
}

pub fn intent_hash(config: &PlatformConfig, fields: &IntentFields) -> [u8; 32] {
    let mut payload = Vec::with_capacity(CANONICAL_INTENT_LENGTH);
    payload.extend_from_slice(&INTENT_DOMAIN_TAG);
    payload.extend_from_slice(&config.network_domain);
    payload.extend_from_slice(crate::ID.as_ref());
    payload.push(fields.action);
    payload.extend_from_slice(fields.campaign.as_ref());
    payload.extend_from_slice(fields.round.as_ref());
    payload.extend_from_slice(fields.wallet.as_ref());
    payload.extend_from_slice(fields.recipient.as_ref());
    payload.extend_from_slice(&fields.nonce);
    payload.extend_from_slice(&fields.expires_at.to_le_bytes());
    debug_assert_eq!(payload.len(), CANONICAL_INTENT_LENGTH);
    hash(&payload).to_bytes()
}

pub fn verify_preceding_ed25519(
    instructions_sysvar: &AccountInfo,
    wallet: &Pubkey,
    expected_hash: &[u8; 32],
) -> Result<()> {
    let current_index = instructions::load_current_index_checked(instructions_sysvar)? as usize;
    require!(current_index > 0, GoalDropError::MissingEd25519Instruction);
    let ix = instructions::load_instruction_at_checked(current_index - 1, instructions_sysvar)?;
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        GoalDropError::MissingEd25519Instruction
    );
    let data = ix.data;
    require!(
        data.len() >= 16 && data[0] == 1 && data[1] == 0,
        GoalDropError::InvalidEd25519Instruction
    );
    let read_u16 = |offset: usize| -> Result<usize> {
        let bytes: [u8; 2] = data
            .get(offset..offset + 2)
            .ok_or(error!(GoalDropError::InvalidEd25519Instruction))?
            .try_into()
            .map_err(|_| error!(GoalDropError::InvalidEd25519Instruction))?;
        Ok(u16::from_le_bytes(bytes) as usize)
    };
    let signature_offset = read_u16(2)?;
    let signature_ix = read_u16(4)?;
    let public_key_offset = read_u16(6)?;
    let public_key_ix = read_u16(8)?;
    let message_offset = read_u16(10)?;
    let message_size = read_u16(12)?;
    let message_ix = read_u16(14)?;
    require!(
        signature_ix == u16::MAX as usize
            && public_key_ix == u16::MAX as usize
            && message_ix == u16::MAX as usize,
        GoalDropError::InvalidEd25519Instruction
    );
    require!(message_size == 32, GoalDropError::InvalidEd25519Instruction);
    require!(
        signature_offset
            .checked_add(64)
            .is_some_and(|end| end <= data.len()),
        GoalDropError::InvalidEd25519Instruction
    );
    let public_key = data
        .get(public_key_offset..public_key_offset + 32)
        .ok_or(error!(GoalDropError::InvalidEd25519Instruction))?;
    let message = data
        .get(message_offset..message_offset + message_size)
        .ok_or(error!(GoalDropError::InvalidEd25519Instruction))?;
    require!(
        public_key == wallet.as_ref() && message == expected_hash,
        GoalDropError::Ed25519IntentMismatch
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DEVNET_NETWORK_DOMAIN;

    #[test]
    fn intent_layout_is_fixed_width() {
        let config = PlatformConfig {
            version: 1,
            bump: 1,
            pause_mask: 0,
            authority_epoch: 0,
            admin: Pubkey::default(),
            oracle: Pubkey::default(),
            relayer: Pubkey::default(),
            demo_authority: Pubkey::default(),
            reward_mint: Pubkey::default(),
            network_domain: DEVNET_NETWORK_DOMAIN,
            reward_decimals: 6,
            reserved: [0; 31],
        };
        let digest = intent_hash(
            &config,
            &IntentFields {
                action: REGISTER_ACTION,
                campaign: Pubkey::new_from_array([1; 32]),
                round: Pubkey::default(),
                wallet: Pubkey::new_from_array([2; 32]),
                recipient: Pubkey::new_from_array([2; 32]),
                nonce: [3; 16],
                expires_at: 1_900_000_000,
            },
        );
        assert_eq!(
            digest,
            [
                0xc6, 0x9d, 0xf6, 0x78, 0x9d, 0x5c, 0xb8, 0x4e, 0x09, 0x56, 0x7f, 0xf3, 0x2e, 0xf2,
                0x87, 0xa6, 0x2b, 0x4e, 0x59, 0xcd, 0x50, 0xdf, 0x69, 0x4c, 0x63, 0xff, 0xab, 0xfa,
                0x06, 0x6b, 0xe1, 0x7b,
            ]
        );
    }
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

pub mod errors;
pub mod events;
pub mod intent;
pub mod state;

use errors::GoalDropError;
use events::*;
use intent::{intent_hash, verify_preceding_ed25519, IntentFields, CLAIM_ACTION, REGISTER_ACTION};
use state::*;

declare_id!("2NUW8WnPJpsSruWhQ5as8AeynBDdfhth5YBXpFWfxZnc");

#[program]
pub mod goaldrop {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        require!(
            args.network_domain == DEVNET_NETWORK_DOMAIN,
            GoalDropError::InvalidIntentHash
        );
        require!(
            args.reward_decimals == ctx.accounts.reward_mint.decimals,
            GoalDropError::InvalidRewardMint
        );
        require!(
            ctx.accounts.reward_mint.freeze_authority == COption::None,
            GoalDropError::InvalidRewardMint
        );
        let admin = ctx.accounts.admin.key();
        let authorities = [admin, args.oracle, args.relayer, args.demo_authority];
        require!(
            authorities.iter().all(|key| *key != Pubkey::default()),
            GoalDropError::Unauthorized
        );
        for left in 0..authorities.len() {
            for right in (left + 1)..authorities.len() {
                require_keys_neq!(
                    authorities[left],
                    authorities[right],
                    GoalDropError::Unauthorized
                );
            }
        }
        let config = &mut ctx.accounts.config;
        config.version = PROGRAM_VERSION;
        config.bump = ctx.bumps.config;
        config.pause_mask = 0;
        config.authority_epoch = 0;
        config.admin = admin;
        config.oracle = args.oracle;
        config.relayer = args.relayer;
        config.demo_authority = args.demo_authority;
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.network_domain = args.network_domain;
        config.reward_decimals = args.reward_decimals;
        config.reserved = [0; 31];
        Ok(())
    }

    pub fn set_pause_mask(ctx: Context<AdminConfig>, new_mask: u16) -> Result<()> {
        require!(
            new_mask & !VALID_PAUSE_MASK == 0,
            GoalDropError::InvalidPauseMask
        );
        let config = &mut ctx.accounts.config;
        let old_mask = config.pause_mask;
        config.pause_mask = new_mask;
        emit!(PauseChanged {
            authority_epoch: config.authority_epoch,
            old_mask,
            new_mask
        });
        Ok(())
    }

    pub fn rotate_authority(
        ctx: Context<AdminConfig>,
        role: u8,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            GoalDropError::Unauthorized
        );
        let config = &mut ctx.accounts.config;
        let old_authority = match role {
            0 => {
                let old = config.admin;
                config.admin = new_authority;
                old
            }
            1 => {
                let old = config.oracle;
                config.oracle = new_authority;
                old
            }
            2 => {
                let old = config.relayer;
                config.relayer = new_authority;
                old
            }
            3 => {
                let old = config.demo_authority;
                config.demo_authority = new_authority;
                old
            }
            _ => return err!(GoalDropError::InvalidAuthorityRole),
        };
        require_keys_neq!(old_authority, new_authority, GoalDropError::Unauthorized);
        let active = [
            config.admin,
            config.oracle,
            config.relayer,
            config.demo_authority,
        ];
        for left in 0..active.len() {
            for right in (left + 1)..active.len() {
                require_keys_neq!(active[left], active[right], GoalDropError::Unauthorized);
            }
        }
        config.authority_epoch = config
            .authority_epoch
            .checked_add(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        emit!(AuthorityRotated {
            authority_epoch: config.authority_epoch,
            role,
            old_authority,
            new_authority
        });
        Ok(())
    }

    pub fn create_campaign(ctx: Context<CreateCampaign>, args: CreateCampaignArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_CAMPAIGN_WRITES)?;
        require_keys_eq!(
            ctx.accounts.config.reward_mint,
            ctx.accounts.reward_mint.key(),
            GoalDropError::InvalidRewardMint
        );
        require!(
            ctx.accounts.config.reward_decimals == ctx.accounts.reward_mint.decimals,
            GoalDropError::InvalidRewardMint
        );
        let now = Clock::get()?.unix_timestamp;
        validate_campaign_args(&args, now)?;
        require!(
            ctx.accounts.refund_wallet.key() != Pubkey::default(),
            GoalDropError::InvalidRefundDestination
        );
        let required_funding = required_funding(&args.rounds, args.round_count)?;
        let campaign_key = ctx.accounts.campaign.key();
        let sponsor_key = ctx.accounts.sponsor.key();
        let fixture = &mut ctx.accounts.fixture_slot;
        fixture.bump = ctx.bumps.fixture_slot;
        fixture.fixture_id = args.fixture_id;
        fixture.campaign = campaign_key;
        fixture.reserved_at = now;
        fixture.reserved = [0; 15];

        let campaign = &mut ctx.accounts.campaign;
        campaign.version = PROGRAM_VERSION;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;
        campaign.state = campaign_state::DRAFT;
        campaign.round_count = args.round_count;
        campaign.next_round = 0;
        campaign.open_round_count = 0;
        campaign.terminal_reason = terminal_reason::NONE;
        campaign.sponsor = sponsor_key;
        campaign.fixture_slot = fixture.key();
        campaign.fixture_id = args.fixture_id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.refund_wallet = ctx.accounts.refund_wallet.key();
        campaign.scheduled_start = args.scheduled_start;
        campaign.registration_deadline = args.registration_deadline;
        campaign.expected_end = args.expected_end;
        campaign.hard_expiry = args.hard_expiry;
        campaign.created_at = now;
        campaign.activated_at = 0;
        campaign.match_complete_at = 0;
        campaign.campaign_nonce = args.campaign_nonce;
        campaign.required_funding = required_funding;
        campaign.funded_amount = 0;
        campaign.paid_amount = 0;
        campaign.refunded_amount = 0;
        campaign.external_inflow_total = 0;
        campaign.rounds = args.rounds;
        campaign.reserved = [0; 32];
        emit!(CampaignCreated {
            version: PROGRAM_VERSION,
            campaign: campaign_key,
            fixture_id: args.fixture_id,
            sponsor: sponsor_key,
            mint: ctx.accounts.reward_mint.key(),
            required_funding,
            round_count: args.round_count,
        });
        Ok(())
    }

    pub fn fund_campaign(ctx: Context<FundCampaign>, amount: u64) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_CAMPAIGN_WRITES)?;
        require!(
            ctx.accounts.campaign.state == campaign_state::DRAFT,
            GoalDropError::InvalidCampaignState
        );
        require!(
            ctx.accounts.campaign.funded_amount == 0
                && amount == ctx.accounts.campaign.required_funding,
            GoalDropError::InvalidFundingAmount
        );
        sync_external_inflow(&mut ctx.accounts.campaign, ctx.accounts.vault.amount)?;
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.sponsor_source.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.sponsor.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;
        let campaign = &mut ctx.accounts.campaign;
        campaign.funded_amount = amount;
        campaign.state = campaign_state::FUNDED;
        emit!(CampaignFunded {
            campaign: campaign.key(),
            deposited_amount: amount,
            vault: ctx.accounts.vault.key()
        });
        Ok(())
    }

    pub fn activate_campaign(ctx: Context<SponsorCampaign>) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_CAMPAIGN_WRITES)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.campaign.state == campaign_state::FUNDED,
            GoalDropError::InvalidCampaignState
        );
        require!(
            now < ctx.accounts.campaign.hard_expiry,
            GoalDropError::CampaignTerminal
        );
        sync_external_inflow(&mut ctx.accounts.campaign, ctx.accounts.vault.amount)?;
        require!(
            ctx.accounts.vault.amount >= ctx.accounts.campaign.required_funding,
            GoalDropError::VaultAccountingDeficit
        );
        let campaign = &mut ctx.accounts.campaign;
        campaign.state = campaign_state::ACTIVE;
        campaign.activated_at = now;
        emit!(CampaignActivated {
            campaign: campaign.key(),
            activated_at: now,
            registration_deadline: campaign.registration_deadline,
            hard_expiry: campaign.hard_expiry,
        });
        Ok(())
    }

    pub fn cancel_campaign(ctx: Context<SponsorCampaign>) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_CAMPAIGN_WRITES)?;
        let now = Clock::get()?.unix_timestamp;
        let campaign = &mut ctx.accounts.campaign;
        require!(
            campaign.state == campaign_state::DRAFT || campaign.state == campaign_state::FUNDED,
            GoalDropError::InvalidCampaignState
        );
        require!(
            now < campaign.scheduled_start
                && campaign.match_complete_at == 0
                && campaign.next_round == 0
                && campaign.open_round_count == 0,
            GoalDropError::InvalidCampaignState
        );
        campaign.state = campaign_state::CANCELLED;
        Ok(())
    }

    pub fn register_fan(ctx: Context<RegisterFan>, args: FanIntentArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_REGISTRATION)?;
        require_keys_eq!(
            ctx.accounts.config.relayer,
            ctx.accounts.relayer.key(),
            GoalDropError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        let campaign = &ctx.accounts.campaign;
        require!(
            campaign.state == campaign_state::ACTIVE,
            GoalDropError::InvalidCampaignState
        );
        require!(
            campaign.terminal_reason == terminal_reason::NONE && now < campaign.hard_expiry,
            GoalDropError::CampaignTerminal
        );
        require!(
            now <= campaign.registration_deadline,
            GoalDropError::RegistrationClosed
        );
        require!(now <= args.expires_at, GoalDropError::IntentExpired);
        let wallet = ctx.accounts.wallet.key();
        let fields = IntentFields {
            action: REGISTER_ACTION,
            campaign: campaign.key(),
            round: Pubkey::default(),
            wallet,
            recipient: wallet,
            nonce: args.nonce,
            expires_at: args.expires_at,
        };
        let canonical_hash = intent_hash(&ctx.accounts.config, &fields);
        require!(
            canonical_hash == args.intent_hash,
            GoalDropError::InvalidIntentHash
        );
        verify_preceding_ed25519(
            &ctx.accounts.instructions.to_account_info(),
            &wallet,
            &canonical_hash,
        )?;
        let registration = &mut ctx.accounts.registration;
        registration.version = PROGRAM_VERSION;
        registration.bump = ctx.bumps.registration;
        registration.campaign = campaign.key();
        registration.wallet = wallet;
        registration.registered_at = now;
        registration.intent_hash = canonical_hash;
        registration.reserved = [0; 14];
        emit!(FanRegistered {
            campaign: campaign.key(),
            wallet,
            registered_at: now,
            intent_hash: canonical_hash
        });
        Ok(())
    }

    pub fn open_live_round(ctx: Context<OpenLiveRound>, args: OpenLiveRoundArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_ROUND_OPEN)?;
        require_keys_eq!(
            ctx.accounts.config.oracle,
            ctx.accounts.oracle.key(),
            GoalDropError::Unauthorized
        );
        require!(
            matches!(args.provider_status, 2 | 4 | 7 | 9),
            GoalDropError::InvalidFixture
        );
        require!(args.confirmed_at_open <= 1, GoalDropError::InvalidFixture);
        open_round(
            &mut ctx.accounts.campaign,
            &mut ctx.accounts.round,
            &mut ctx.accounts.goal_receipt,
            ctx.bumps.round,
            ctx.bumps.goal_receipt,
            round_source::LIVE,
            args.fixture_id,
            args.event_hash,
            args.provider_action_id,
            args.provider_seq,
            args.provider_status,
            args.confirmed_at_open,
            args.provider_ts_ms,
            args.raw_digest,
        )
    }

    pub fn open_demo_round(ctx: Context<OpenDemoRound>, args: OpenDemoRoundArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_ROUND_OPEN)?;
        require_keys_eq!(
            ctx.accounts.config.demo_authority,
            ctx.accounts.demo_authority.key(),
            GoalDropError::Unauthorized
        );
        require!(args.event_hash != [0; 32], GoalDropError::InvalidFixture);
        open_round(
            &mut ctx.accounts.campaign,
            &mut ctx.accounts.round,
            &mut ctx.accounts.goal_receipt,
            ctx.bumps.round,
            ctx.bumps.goal_receipt,
            round_source::DEMO,
            args.fixture_id,
            args.event_hash,
            args.demo_nonce,
            0,
            0,
            1,
            args.provider_ts_ms,
            args.raw_digest,
        )
    }

    pub fn settle_claim(ctx: Context<SettleClaim>, args: SettleClaimArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_SETTLEMENT)?;
        require_keys_eq!(
            ctx.accounts.config.relayer,
            ctx.accounts.relayer.key(),
            GoalDropError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        let campaign_key = ctx.accounts.campaign.key();
        let round_key = ctx.accounts.round.key();
        let wallet = ctx.accounts.wallet.key();
        require_keys_eq!(
            wallet,
            ctx.accounts.recipient_owner.key(),
            GoalDropError::RecipientMismatch
        );
        require!(
            ctx.accounts.round.state == round_state::OPEN,
            GoalDropError::InvalidRoundState
        );
        require!(
            now < ctx.accounts.round.closes_at,
            GoalDropError::RoundExpired
        );
        require!(now <= args.expires_at, GoalDropError::IntentExpired);
        require!(
            args.sequence == ctx.accounts.round.next_sequence,
            GoalDropError::InvalidSequence
        );
        require!(
            ctx.accounts.round.winner_count < ctx.accounts.round.winner_cap,
            GoalDropError::WinnerCapReached
        );
        let canonical_ata = get_associated_token_address_with_program_id(
            &wallet,
            &ctx.accounts.reward_mint.key(),
            &token::ID,
        );
        require_keys_eq!(
            canonical_ata,
            ctx.accounts.recipient_token.key(),
            GoalDropError::InvalidTokenDestination
        );
        require_keys_eq!(
            ctx.accounts.recipient_token.owner,
            wallet,
            GoalDropError::InvalidTokenDestination
        );
        let fields = IntentFields {
            action: CLAIM_ACTION,
            campaign: campaign_key,
            round: round_key,
            wallet,
            recipient: wallet,
            nonce: args.nonce,
            expires_at: args.expires_at,
        };
        let canonical_hash = intent_hash(&ctx.accounts.config, &fields);
        require!(
            canonical_hash == args.intent_hash,
            GoalDropError::InvalidIntentHash
        );
        verify_preceding_ed25519(
            &ctx.accounts.instructions.to_account_info(),
            &wallet,
            &canonical_hash,
        )?;
        sync_external_inflow(&mut ctx.accounts.campaign, ctx.accounts.vault.amount)?;
        require!(
            ctx.accounts.vault.amount >= ctx.accounts.round.reward_amount,
            GoalDropError::VaultAccountingDeficit
        );

        let sponsor = ctx.accounts.campaign.sponsor;
        let nonce = ctx.accounts.campaign.campaign_nonce.to_le_bytes();
        let bump = [ctx.accounts.campaign.bump];
        let signer_seeds: &[&[u8]] = &[b"campaign", sponsor.as_ref(), &nonce, &bump];
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.reward_mint.to_account_info(),
            to: ctx.accounts.recipient_token.to_account_info(),
            authority: ctx.accounts.campaign.to_account_info(),
        };
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                &[signer_seeds],
            ),
            ctx.accounts.round.reward_amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        let amount = ctx.accounts.round.reward_amount;
        let rank = ctx
            .accounts
            .round
            .winner_count
            .checked_add(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        let round = &mut ctx.accounts.round;
        round.winner_count = rank;
        round.next_sequence = round
            .next_sequence
            .checked_add(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        round.paid_total = round
            .paid_total
            .checked_add(amount)
            .ok_or(GoalDropError::AccountingOverflow)?;
        ctx.accounts.campaign.paid_amount = ctx
            .accounts
            .campaign
            .paid_amount
            .checked_add(amount)
            .ok_or(GoalDropError::AccountingOverflow)?;
        if round.winner_count == round.winner_cap {
            round.state = round_state::EXHAUSTED;
            ctx.accounts.campaign.open_round_count = ctx
                .accounts
                .campaign
                .open_round_count
                .checked_sub(1)
                .ok_or(GoalDropError::ArithmeticOverflow)?;
        }
        let claim = &mut ctx.accounts.claim;
        claim.version = PROGRAM_VERSION;
        claim.bump = ctx.bumps.claim;
        claim.winner_rank = rank;
        claim.campaign = campaign_key;
        claim.round = round_key;
        claim.wallet = wallet;
        claim.recipient = wallet;
        claim.sequence = args.sequence;
        claim.amount = amount;
        claim.paid_at = now;
        claim.intent_hash = canonical_hash;
        claim.reserved = [0; 4];
        emit!(ClaimPaid {
            campaign: campaign_key,
            round: round_key,
            wallet,
            sequence: args.sequence,
            winner_rank: rank,
            amount,
            intent_hash: canonical_hash
        });
        if round.state == round_state::EXHAUSTED {
            emit!(RoundClosed {
                campaign: campaign_key,
                round: round_key,
                state: round.state,
                winners: round.winner_count,
                paid_total: round.paid_total,
                skipped_count: round.skipped_count
            });
        }
        Ok(())
    }

    pub fn skip_sequence(ctx: Context<SkipSequence>, args: SkipSequenceArgs) -> Result<()> {
        require_unpaused(&ctx.accounts.config, PAUSE_SETTLEMENT)?;
        require_keys_eq!(
            ctx.accounts.config.relayer,
            ctx.accounts.relayer.key(),
            GoalDropError::Unauthorized
        );
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.state == round_state::OPEN,
            GoalDropError::InvalidRoundState
        );
        require!(now < round.closes_at, GoalDropError::RoundExpired);
        require!(
            args.sequence == round.next_sequence,
            GoalDropError::InvalidSequence
        );
        require!(
            matches!(
                args.reason,
                skip_reason::INVALID_AFTER_ACCEPTANCE
                    | skip_reason::RECIPIENT_ACCOUNT_FAILURE
                    | skip_reason::PERMANENT_PROGRAM_MISMATCH
                    | skip_reason::OPERATOR_INCIDENT
            ),
            GoalDropError::InvalidSkipReason
        );
        round.next_sequence = round
            .next_sequence
            .checked_add(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        round.skipped_count = round
            .skipped_count
            .checked_add(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        emit!(SequenceSkipped {
            campaign: ctx.accounts.campaign.key(),
            round: round.key(),
            sequence: args.sequence,
            intent_hash: args.intent_hash,
            reason: args.reason
        });
        Ok(())
    }

    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            round.state == round_state::OPEN,
            GoalDropError::InvalidRoundState
        );
        require!(now >= round.closes_at, GoalDropError::RoundExpired);
        round.state = round_state::EXPIRED;
        ctx.accounts.campaign.open_round_count = ctx
            .accounts
            .campaign
            .open_round_count
            .checked_sub(1)
            .ok_or(GoalDropError::ArithmeticOverflow)?;
        emit!(RoundClosed {
            campaign: ctx.accounts.campaign.key(),
            round: round.key(),
            state: round.state,
            winners: round.winner_count,
            paid_total: round.paid_total,
            skipped_count: round.skipped_count
        });
        Ok(())
    }

    pub fn mark_match_complete(
        ctx: Context<OracleCampaign>,
        args: MatchCompleteArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.config.oracle,
            ctx.accounts.oracle.key(),
            GoalDropError::Unauthorized
        );
        require!(
            matches!(
                args.terminal_reason,
                terminal_reason::PROVIDER_FINALISED
                    | terminal_reason::PROVIDER_CANCELLED
                    | terminal_reason::PROVIDER_ABANDONED
            ),
            GoalDropError::CampaignNotTerminal
        );
        let now = Clock::get()?.unix_timestamp;
        let campaign = &mut ctx.accounts.campaign;
        require!(
            campaign.state == campaign_state::ACTIVE
                && campaign.terminal_reason == terminal_reason::NONE,
            GoalDropError::InvalidCampaignState
        );
        campaign.terminal_reason = args.terminal_reason;
        campaign.match_complete_at = now;
        emit!(MatchCompleted {
            campaign: campaign.key(),
            terminal_reason: args.terminal_reason,
            provider_action_id: args.provider_action_id,
            provider_seq: args.provider_seq,
            completed_at: now
        });
        Ok(())
    }

    pub fn finalize_after_timeout(ctx: Context<PermissionlessCampaign>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let campaign = &mut ctx.accounts.campaign;
        require!(
            campaign.state == campaign_state::ACTIVE
                && campaign.terminal_reason == terminal_reason::NONE,
            GoalDropError::InvalidCampaignState
        );
        require!(
            now >= campaign.hard_expiry,
            GoalDropError::CampaignNotTerminal
        );
        campaign.terminal_reason = terminal_reason::HARD_TIMEOUT;
        campaign.match_complete_at = now;
        emit!(MatchCompleted {
            campaign: campaign.key(),
            terminal_reason: terminal_reason::HARD_TIMEOUT,
            provider_action_id: 0,
            provider_seq: 0,
            completed_at: now
        });
        Ok(())
    }

    pub fn make_refundable(ctx: Context<MakeRefundable>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let terminal = campaign.state == campaign_state::CANCELLED
            || (campaign.state == campaign_state::ACTIVE
                && campaign.terminal_reason != terminal_reason::NONE);
        require!(terminal, GoalDropError::CampaignNotTerminal);
        require!(
            campaign.open_round_count == 0,
            GoalDropError::OpenRoundsRemain
        );
        sync_external_inflow(campaign, ctx.accounts.vault.amount)?;
        campaign.state = campaign_state::REFUNDABLE;
        emit!(CampaignRefundable {
            campaign: campaign.key(),
            paid_amount: campaign.paid_amount,
            residual_balance: ctx.accounts.vault.amount
        });
        Ok(())
    }

    pub fn refund_campaign(ctx: Context<RefundCampaign>) -> Result<()> {
        require!(
            ctx.accounts.campaign.state == campaign_state::REFUNDABLE,
            GoalDropError::InvalidCampaignState
        );
        require!(
            ctx.accounts.campaign.open_round_count == 0,
            GoalDropError::OpenRoundsRemain
        );
        require_keys_eq!(
            ctx.accounts.refund_wallet.key(),
            ctx.accounts.campaign.refund_wallet,
            GoalDropError::InvalidRefundDestination
        );
        let canonical_ata = get_associated_token_address_with_program_id(
            &ctx.accounts.refund_wallet.key(),
            &ctx.accounts.reward_mint.key(),
            &token::ID,
        );
        require_keys_eq!(
            canonical_ata,
            ctx.accounts.refund_token.key(),
            GoalDropError::InvalidTokenDestination
        );
        sync_external_inflow(&mut ctx.accounts.campaign, ctx.accounts.vault.amount)?;
        let amount = ctx.accounts.vault.amount;
        let sponsor = ctx.accounts.campaign.sponsor;
        let nonce = ctx.accounts.campaign.campaign_nonce.to_le_bytes();
        let bump = [ctx.accounts.campaign.bump];
        let signer_seeds: &[&[u8]] = &[b"campaign", sponsor.as_ref(), &nonce, &bump];
        if amount > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.reward_mint.to_account_info(),
                        to: ctx.accounts.refund_token.to_account_info(),
                        authority: ctx.accounts.campaign.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                amount,
                ctx.accounts.reward_mint.decimals,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.refund_wallet.to_account_info(),
                authority: ctx.accounts.campaign.to_account_info(),
            },
            &[signer_seeds],
        ))?;
        let campaign = &mut ctx.accounts.campaign;
        campaign.refunded_amount = campaign
            .refunded_amount
            .checked_add(amount)
            .ok_or(GoalDropError::AccountingOverflow)?;
        campaign.state = campaign_state::REFUNDED;
        emit!(CampaignRefunded {
            campaign: campaign.key(),
            refund_wallet: campaign.refund_wallet,
            token_amount: amount,
            vault_closure_recipient: campaign.refund_wallet
        });
        Ok(())
    }

    pub fn release_fixture_slot(ctx: Context<ReleaseFixtureSlot>) -> Result<()> {
        require!(
            ctx.accounts.campaign.state == campaign_state::REFUNDED,
            GoalDropError::InvalidCampaignState
        );
        require_keys_eq!(
            ctx.accounts.fixture_slot.campaign,
            ctx.accounts.campaign.key(),
            GoalDropError::InvalidFixtureSlot
        );
        require_keys_eq!(
            ctx.accounts.campaign.fixture_slot,
            ctx.accounts.fixture_slot.key(),
            GoalDropError::InvalidFixtureSlot
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigArgs {
    pub oracle: Pubkey,
    pub relayer: Pubkey,
    pub demo_authority: Pubkey,
    pub network_domain: [u8; 32],
    pub reward_decimals: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateCampaignArgs {
    pub fixture_id: u64,
    pub campaign_nonce: u64,
    pub scheduled_start: i64,
    pub registration_deadline: i64,
    pub expected_end: i64,
    pub hard_expiry: i64,
    pub round_count: u8,
    pub rounds: [RoundConfig; MAX_ROUNDS],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FanIntentArgs {
    pub nonce: [u8; 16],
    pub expires_at: i64,
    pub intent_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenLiveRoundArgs {
    pub fixture_id: u64,
    pub event_hash: [u8; 32],
    pub provider_action_id: u64,
    pub provider_seq: u32,
    pub provider_status: u16,
    pub confirmed_at_open: u8,
    pub provider_ts_ms: i64,
    pub raw_digest: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenDemoRoundArgs {
    pub fixture_id: u64,
    pub event_hash: [u8; 32],
    pub demo_nonce: u64,
    pub provider_ts_ms: i64,
    pub raw_digest: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleClaimArgs {
    pub sequence: u64,
    pub nonce: [u8; 16],
    pub expires_at: i64,
    pub intent_hash: [u8; 32],
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SkipSequenceArgs {
    pub sequence: u64,
    pub intent_hash: [u8; 32],
    pub reason: u8,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MatchCompleteArgs {
    pub terminal_reason: u8,
    pub provider_action_id: u64,
    pub provider_seq: u32,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = admin, space = PlatformConfig::SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub reward_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, PlatformConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreateCampaignArgs)]
pub struct CreateCampaign<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub sponsor: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    /// CHECK: Immutable refund owner; canonical token account is enforced during refund.
    pub refund_wallet: UncheckedAccount<'info>,
    #[account(address = config.reward_mint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(init, payer = fee_payer, space = FixtureSlot::SPACE, seeds = [b"fixture", args.fixture_id.to_le_bytes().as_ref()], bump)]
    pub fixture_slot: Account<'info, FixtureSlot>,
    #[account(init, payer = fee_payer, space = Campaign::SPACE, seeds = [b"campaign", sponsor.key().as_ref(), args.campaign_nonce.to_le_bytes().as_ref()], bump)]
    pub campaign: Account<'info, Campaign>,
    #[account(init, payer = fee_payer, seeds = [b"vault", campaign.key().as_ref()], bump, token::mint = reward_mint, token::authority = campaign, token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundCampaign<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(mut, has_one = sponsor, has_one = reward_mint, seeds = [b"campaign", sponsor.key().as_ref(), campaign.campaign_nonce.to_le_bytes().as_ref()], bump = campaign.bump)]
    pub campaign: Account<'info, Campaign>,
    #[account(mut, token::mint = reward_mint, token::authority = sponsor)]
    pub sponsor_source: Account<'info, TokenAccount>,
    #[account(address = config.reward_mint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut, seeds = [b"vault", campaign.key().as_ref()], bump = campaign.vault_bump, token::mint = reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SponsorCampaign<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub sponsor: Signer<'info>,
    #[account(mut, has_one = sponsor, seeds = [b"campaign", sponsor.key().as_ref(), campaign.campaign_nonce.to_le_bytes().as_ref()], bump = campaign.bump)]
    pub campaign: Account<'info, Campaign>,
    #[account(seeds = [b"vault", campaign.key().as_ref()], bump = campaign.vault_bump, token::mint = campaign.reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(args: FanIntentArgs)]
pub struct RegisterFan<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub campaign: Account<'info, Campaign>,
    /// CHECK: The Ed25519 precompile proves control of this public key.
    pub wallet: UncheckedAccount<'info>,
    #[account(init, payer = fee_payer, space = Registration::SPACE, seeds = [b"registration", campaign.key().as_ref(), wallet.key().as_ref()], bump)]
    pub registration: Account<'info, Registration>,
    pub relayer: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    /// CHECK: Address is constrained to the instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: OpenLiveRoundArgs)]
pub struct OpenLiveRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub oracle: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(init, payer = fee_payer, space = Round::SPACE, seeds = [b"round", campaign.key().as_ref(), &[campaign.next_round]], bump)]
    pub round: Account<'info, Round>,
    #[account(init, payer = fee_payer, space = GoalReceipt::SPACE, seeds = [b"goal", campaign.key().as_ref(), &args.event_hash], bump)]
    pub goal_receipt: Account<'info, GoalReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: OpenDemoRoundArgs)]
pub struct OpenDemoRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub demo_authority: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(init, payer = fee_payer, space = Round::SPACE, seeds = [b"round", campaign.key().as_ref(), &[campaign.next_round]], bump)]
    pub round: Account<'info, Round>,
    #[account(init, payer = fee_payer, space = GoalReceipt::SPACE, seeds = [b"goal", campaign.key().as_ref(), &args.event_hash], bump)]
    pub goal_receipt: Account<'info, GoalReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: SettleClaimArgs)]
pub struct SettleClaim<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(mut, has_one = reward_mint)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, has_one = campaign)]
    pub round: Box<Account<'info, Round>>,
    /// CHECK: Fan key is verified by Ed25519 and Registration PDA.
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: Must equal wallet and own the canonical recipient token account.
    pub recipient_owner: UncheckedAccount<'info>,
    #[account(has_one = campaign, has_one = wallet, seeds = [b"registration", campaign.key().as_ref(), wallet.key().as_ref()], bump = registration.bump)]
    pub registration: Box<Account<'info, Registration>>,
    #[account(init, payer = fee_payer, space = Claim::SPACE, seeds = [b"claim", round.key().as_ref(), wallet.key().as_ref()], bump)]
    pub claim: Box<Account<'info, Claim>>,
    pub relayer: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut, seeds = [b"vault", campaign.key().as_ref()], bump = campaign.vault_bump, token::mint = reward_mint, token::authority = campaign)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.reward_mint)]
    pub reward_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = reward_mint)]
    pub recipient_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: Address is constrained to the instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SkipSequence<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    pub campaign: Account<'info, Campaign>,
    #[account(mut, has_one = campaign)]
    pub round: Account<'info, Round>,
    pub relayer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(mut, has_one = campaign)]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct OracleCampaign<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, PlatformConfig>,
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct PermissionlessCampaign<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
}

#[derive(Accounts)]
pub struct MakeRefundable<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,
    #[account(seeds = [b"vault", campaign.key().as_ref()], bump = campaign.vault_bump, token::mint = campaign.reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct RefundCampaign<'info> {
    #[account(mut, has_one = reward_mint)]
    pub campaign: Account<'info, Campaign>,
    #[account(mut, seeds = [b"vault", campaign.key().as_ref()], bump = campaign.vault_bump, token::mint = reward_mint, token::authority = campaign)]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = campaign.reward_mint)]
    pub reward_mint: Account<'info, Mint>,
    /// CHECK: Must equal immutable campaign refund wallet; also receives closed-vault rent.
    #[account(mut)]
    pub refund_wallet: UncheckedAccount<'info>,
    #[account(mut, token::mint = reward_mint, token::authority = refund_wallet)]
    pub refund_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseFixtureSlot<'info> {
    pub campaign: Account<'info, Campaign>,
    #[account(mut, close = rent_recipient, seeds = [b"fixture", &fixture_slot.fixture_id.to_le_bytes()], bump = fixture_slot.bump)]
    pub fixture_slot: Account<'info, FixtureSlot>,
    /// CHECK: Fixture-slot rent returns to the same immutable refund wallet as token residuals.
    #[account(mut, address = campaign.refund_wallet)]
    pub rent_recipient: UncheckedAccount<'info>,
}

fn require_unpaused(config: &PlatformConfig, bit: u16) -> Result<()> {
    require!(config.pause_mask & bit == 0, GoalDropError::Paused);
    Ok(())
}

fn validate_campaign_args(args: &CreateCampaignArgs, now: i64) -> Result<()> {
    require!(
        now < args.registration_deadline
            && args.registration_deadline <= args.scheduled_start
            && args.scheduled_start < args.expected_end
            && args.expected_end < args.hard_expiry
            && args.hard_expiry
                <= args
                    .scheduled_start
                    .checked_add(MAX_HARD_EXPIRY_SECONDS)
                    .ok_or(GoalDropError::ArithmeticOverflow)?,
        GoalDropError::InvalidTimeBounds
    );
    require!(
        args.fixture_id > 0 && args.round_count > 0 && args.round_count as usize <= MAX_ROUNDS,
        GoalDropError::InvalidRoundConfig
    );
    for (index, round) in args.rounds.iter().enumerate() {
        if index < args.round_count as usize {
            require!(
                round.reward_amount > 0 && round.reward_amount <= MAX_REWARD_AMOUNT,
                GoalDropError::InvalidRoundConfig
            );
            require!(
                round.winner_cap > 0 && round.winner_cap <= MAX_WINNERS_PER_ROUND,
                GoalDropError::InvalidRoundConfig
            );
            require!(round.reserved == [0; 6], GoalDropError::InvalidRoundConfig);
        } else {
            require!(
                *round == RoundConfig::default(),
                GoalDropError::InvalidRoundConfig
            );
        }
    }
    Ok(())
}

fn required_funding(rounds: &[RoundConfig; MAX_ROUNDS], count: u8) -> Result<u64> {
    let mut total: u128 = 0;
    for round in rounds.iter().take(count as usize) {
        let liability = (round.reward_amount as u128)
            .checked_mul(round.winner_cap as u128)
            .ok_or(GoalDropError::FundingOverflow)?;
        total = total
            .checked_add(liability)
            .ok_or(GoalDropError::FundingOverflow)?;
    }
    u64::try_from(total).map_err(|_| error!(GoalDropError::FundingOverflow))
}

#[allow(clippy::too_many_arguments)]
fn open_round(
    campaign: &mut Account<Campaign>,
    round: &mut Account<Round>,
    receipt: &mut Account<GoalReceipt>,
    round_bump: u8,
    receipt_bump: u8,
    source: u8,
    fixture_id: u64,
    event_hash: [u8; 32],
    action_id: u64,
    provider_seq: u32,
    provider_status: u16,
    confirmed_at_open: u8,
    provider_ts_ms: i64,
    raw_digest: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        campaign.state == campaign_state::ACTIVE,
        GoalDropError::InvalidCampaignState
    );
    require!(
        campaign.terminal_reason == terminal_reason::NONE && now < campaign.hard_expiry,
        GoalDropError::CampaignTerminal
    );
    require!(
        campaign.fixture_id == fixture_id,
        GoalDropError::InvalidFixture
    );
    require!(
        campaign.next_round < campaign.round_count,
        GoalDropError::NoRoundsRemaining
    );
    require!(event_hash != [0; 32], GoalDropError::InvalidFixture);
    let ordinal = campaign.next_round;
    let economics = campaign.rounds[ordinal as usize];
    let closes_at = now
        .checked_add(ROUND_DURATION_SECONDS)
        .ok_or(GoalDropError::ArithmeticOverflow)?;
    round.version = PROGRAM_VERSION;
    round.bump = round_bump;
    round.state = round_state::OPEN;
    round.source = source;
    round.ordinal = ordinal;
    round.reserved_header = [0; 3];
    round.campaign = campaign.key();
    round.goal_receipt = receipt.key();
    round.event_hash = event_hash;
    round.provider_action_id = action_id;
    round.provider_seq = provider_seq;
    round.provider_status = provider_status;
    round.reserved_provider = [0; 2];
    round.provider_ts_ms = provider_ts_ms;
    round.opened_at = now;
    round.closes_at = closes_at;
    round.reward_amount = economics.reward_amount;
    round.winner_cap = economics.winner_cap;
    round.winner_count = 0;
    round.next_sequence = 1;
    round.skipped_count = 0;
    round.paid_total = 0;
    round.reserved = [0; 32];
    receipt.version = PROGRAM_VERSION;
    receipt.bump = receipt_bump;
    receipt.source = source;
    receipt.round_ordinal = ordinal;
    receipt.campaign = campaign.key();
    receipt.event_hash = event_hash;
    receipt.provider_action_id = action_id;
    receipt.provider_seq = provider_seq;
    receipt.provider_status = provider_status;
    receipt.confirmed_at_open = confirmed_at_open;
    receipt.reserved_header = 0;
    receipt.provider_ts_ms = provider_ts_ms;
    receipt.opened_at = now;
    receipt.raw_digest = raw_digest;
    receipt.reserved = [0; 28];
    campaign.next_round = campaign
        .next_round
        .checked_add(1)
        .ok_or(GoalDropError::ArithmeticOverflow)?;
    campaign.open_round_count = campaign
        .open_round_count
        .checked_add(1)
        .ok_or(GoalDropError::ArithmeticOverflow)?;
    emit!(RoundOpened {
        campaign: campaign.key(),
        round: round.key(),
        ordinal,
        source,
        event_hash,
        opened_at: now,
        closes_at,
        reward_amount: economics.reward_amount,
        winner_cap: economics.winner_cap,
    });
    Ok(())
}

fn sync_external_inflow(campaign: &mut Campaign, actual_balance: u64) -> Result<()> {
    let incoming = (campaign.funded_amount as u128)
        .checked_add(campaign.external_inflow_total)
        .ok_or(GoalDropError::AccountingOverflow)?;
    let outgoing = (campaign.paid_amount as u128)
        .checked_add(campaign.refunded_amount as u128)
        .ok_or(GoalDropError::AccountingOverflow)?;
    let expected = incoming
        .checked_sub(outgoing)
        .ok_or(GoalDropError::VaultAccountingDeficit)?;
    let actual = actual_balance as u128;
    require!(actual >= expected, GoalDropError::VaultAccountingDeficit);
    let inflow = actual
        .checked_sub(expected)
        .ok_or(GoalDropError::AccountingOverflow)?;
    campaign.external_inflow_total = campaign
        .external_inflow_total
        .checked_add(inflow)
        .ok_or(GoalDropError::AccountingOverflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_required_funding() {
        let mut rounds = [RoundConfig::default(); MAX_ROUNDS];
        rounds[0] = RoundConfig {
            reward_amount: 10,
            winner_cap: 100,
            reserved: [0; 6],
        };
        rounds[1] = RoundConfig {
            reward_amount: 7,
            winner_cap: 3,
            reserved: [0; 6],
        };
        assert_eq!(required_funding(&rounds, 2).unwrap(), 1_021);
    }

    #[test]
    fn unsolicited_inflow_is_recorded_and_deficit_rejected() {
        let mut campaign: Campaign = unsafe { std::mem::zeroed() };
        campaign.funded_amount = 1_000;
        campaign.paid_amount = 100;
        sync_external_inflow(&mut campaign, 950).unwrap();
        assert_eq!(campaign.external_inflow_total, 50);
        assert!(sync_external_inflow(&mut campaign, 949).is_err());
    }

    #[test]
    fn campaign_arguments_reject_zero_and_out_of_range_economics() {
        let mut rounds = [RoundConfig::default(); MAX_ROUNDS];
        rounds[0] = RoundConfig {
            reward_amount: 1,
            winner_cap: 1,
            reserved: [0; 6],
        };
        let valid = CreateCampaignArgs {
            fixture_id: 1,
            campaign_nonce: 1,
            scheduled_start: 20,
            registration_deadline: 10,
            expected_end: 30,
            hard_expiry: 40,
            round_count: 1,
            rounds,
        };
        assert!(validate_campaign_args(&valid, 0).is_ok());

        let mut zero_reward = valid.clone();
        zero_reward.rounds[0].reward_amount = 0;
        assert!(validate_campaign_args(&zero_reward, 0).is_err());

        let mut zero_cap = valid.clone();
        zero_cap.rounds[0].winner_cap = 0;
        assert!(validate_campaign_args(&zero_cap, 0).is_err());

        let mut trailing_round = valid.clone();
        trailing_round.rounds[1].reward_amount = 1;
        assert!(validate_campaign_args(&trailing_round, 0).is_err());

        let mut excessive_timeout = valid;
        excessive_timeout.hard_expiry =
            excessive_timeout.scheduled_start + MAX_HARD_EXPIRY_SECONDS + 1;
        assert!(validate_campaign_args(&excessive_timeout, 0).is_err());
    }

    #[test]
    fn funding_overflow_is_rejected() {
        let mut rounds = [RoundConfig::default(); MAX_ROUNDS];
        rounds[0] = RoundConfig {
            reward_amount: u64::MAX,
            winner_cap: u16::MAX,
            reserved: [0; 6],
        };
        assert!(required_funding(&rounds, 1).is_err());
    }
}

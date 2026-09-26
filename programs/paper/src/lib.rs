// SPDX-License-Identifier: Apache-2.0
//! PAPER Protocol — devnet prototype.
//!
//! Identity is checked at the mint and redeem perimeter only. Between those two points the token
//! moves through Token-2022 confidential transfers, so the protocol does not know who holds what.
//! Everything here runs on devnet with valueless test tokens.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("7twaRXVbxhiv9TZnjdbZQjkc9sQYXjbEgu5UWaFbt4zH");

pub const CONFIG_SEED: &[u8] = b"config";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const DISCLOSURE_SEED: &[u8] = b"disclosure";
pub const FAUCET_SEED: &[u8] = b"faucet";
pub const VAULT_SEED: &[u8] = b"vault";

/// 1000 test USDC at six decimals.
pub const FAUCET_AMOUNT: u64 = 1_000_000_000;
/// One drip per wallet per day.
pub const FAUCET_COOLDOWN: i64 = 86_400;
/// A disclosure is recorded immediately and takes effect a day later.
pub const DISCLOSURE_DELAY: i64 = 86_400;
/// Layout version of the `Config` account, so a client can tell deployments apart.
pub const CONFIG_VERSION: u8 = 1;

#[program]
pub mod paper {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        kyc_authority: Pubkey,
        auditor: Pubkey,
        allow_self_attest: bool,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.eusd_mint = ctx.accounts.eusd_mint.key();
        config.test_usdc_mint = ctx.accounts.test_usdc_mint.key();
        config.vault = ctx.accounts.vault.key();
        config.kyc_authority = kyc_authority;
        config.auditor = auditor;
        config.allow_self_attest = allow_self_attest;
        config.disclosure_count = 0;
        config.created_at = Clock::get()?.unix_timestamp;
        config.version = CONFIG_VERSION;
        config.bump = ctx.bumps.config;
        if allow_self_attest {
            msg!("PAPER: self-attestation is ON — devnet only, never a real deployment");
        }
        Ok(())
    }

    /// The KYC partner vouches for a wallet. On devnet a wallet may vouch for itself, which is what
    /// the "Simulate KYC" button does; that path does not exist in the real design.
    pub fn attest_identity(ctx: Context<AttestIdentity>, wallet: Pubkey) -> Result<()> {
        let config = &ctx.accounts.config;
        let signer = ctx.accounts.signer.key();
        let identity_exists = ctx.accounts.identity.wallet != Pubkey::default();
        let revoked = identity_exists && !ctx.accounts.identity.verified;
        // Self-attestation is the devnet shortcut, but it must not be a way to undo a revocation:
        // once a wallet has been struck off, only the KYC partner can put it back.
        let allowed = signer == config.kyc_authority
            || (config.allow_self_attest && signer == wallet && !revoked);
        require!(allowed, PaperError::NotKycAuthority);

        let identity = &mut ctx.accounts.identity;
        identity.wallet = wallet;
        identity.verified = true;
        identity.verified_at = Clock::get()?.unix_timestamp;
        identity.partner = signer;
        identity.bump = ctx.bumps.identity;
        emit!(IdentityAttested {
            wallet,
            partner: signer
        });
        Ok(())
    }

    pub fn revoke_identity(ctx: Context<RevokeIdentity>, wallet: Pubkey) -> Result<()> {
        let config = &ctx.accounts.config;
        let signer = ctx.accounts.signer.key();
        require!(
            signer == config.kyc_authority || signer == config.authority,
            PaperError::NotKycAuthority
        );
        let identity = &mut ctx.accounts.identity;
        identity.verified = false;
        emit!(IdentityRevoked { wallet, by: signer });
        Ok(())
    }

    /// The tap. Anyone may take test USDC once a day, so a visitor can try the flow.
    pub fn faucet_drip(ctx: Context<FaucetDrip>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let record = &mut ctx.accounts.faucet_record;
        if record.wallet != Pubkey::default() {
            let elapsed = now.saturating_sub(record.last_drip);
            require!(elapsed >= FAUCET_COOLDOWN, PaperError::FaucetCooldown);
        }
        record.wallet = ctx.accounts.recipient.key();
        record.last_drip = now;
        record.bump = ctx.bumps.faucet_record;

        let eusd_mint_key = ctx.accounts.config.eusd_mint;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, eusd_mint_key.as_ref(), &bump];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.test_usdc_mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            FAUCET_AMOUNT,
        )?;
        emit!(FaucetDripped {
            wallet: ctx.accounts.recipient.key(),
            amount: FAUCET_AMOUNT,
        });
        Ok(())
    }

    /// Deposit test USDC into the reserve vault and receive eUSD one for one.
    pub fn mint_eusd(ctx: Context<MintEusd>, amount: u64) -> Result<()> {
        require!(amount > 0, PaperError::ZeroAmount);
        require!(ctx.accounts.identity.verified, PaperError::NotVerified);

        let usdc_decimals = ctx.accounts.test_usdc_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    mint: ctx.accounts.test_usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            usdc_decimals,
        )?;

        let eusd_mint_key = ctx.accounts.config.eusd_mint;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, eusd_mint_key.as_ref(), &bump];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.eusd_mint.to_account_info(),
                    to: ctx.accounts.user_eusd.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        emit!(Minted {
            wallet: ctx.accounts.user.key(),
            amount
        });
        Ok(())
    }

    /// Burn eUSD and take the test USDC back out of the vault.
    pub fn redeem_eusd(ctx: Context<RedeemEusd>, amount: u64) -> Result<()> {
        require!(amount > 0, PaperError::ZeroAmount);
        require!(ctx.accounts.identity.verified, PaperError::NotVerified);

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.eusd_mint.to_account_info(),
                    from: ctx.accounts.user_eusd.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let usdc_decimals = ctx.accounts.test_usdc_mint.decimals;
        let eusd_mint_key = ctx.accounts.config.eusd_mint;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, eusd_mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.test_usdc_mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            usdc_decimals,
        )?;
        emit!(Redeemed {
            wallet: ctx.accounts.user.key(),
            amount
        });
        Ok(())
    }

    /// Write a disclosure to the public register. It takes effect a day after it is recorded, so a
    /// disclosure cannot be made and used in the same breath without anyone seeing it.
    pub fn record_disclosure(
        ctx: Context<RecordDisclosure>,
        subject: Pubkey,
        reason_code: u8,
    ) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.config.authority || signer == ctx.accounts.config.auditor,
            PaperError::NotAuthority
        );
        let now = Clock::get()?.unix_timestamp;
        let index = ctx.accounts.config.disclosure_count;

        let entry = &mut ctx.accounts.entry;
        entry.index = index;
        entry.subject = subject;
        entry.requested_by = signer;
        entry.reason_code = reason_code;
        entry.created_at = now;
        entry.effective_at = now
            .checked_add(DISCLOSURE_DELAY)
            .ok_or(PaperError::ArithmeticOverflow)?;
        entry.bump = ctx.bumps.entry;

        ctx.accounts.config.disclosure_count =
            index.checked_add(1).ok_or(PaperError::ArithmeticOverflow)?;
        emit!(DisclosureRecorded {
            index,
            subject,
            reason_code
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub eusd_mint: Pubkey,
    pub test_usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub kyc_authority: Pubkey,
    pub auditor: Pubkey,
    pub disclosure_count: u64,
    pub created_at: i64,
    pub allow_self_attest: bool,
    pub version: u8,
    pub bump: u8,
}

/// One entry in the Identity Whitelist Registry.
#[account]
#[derive(InitSpace)]
pub struct IdentityRecord {
    pub wallet: Pubkey,
    pub partner: Pubkey,
    pub verified_at: i64,
    pub verified: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DisclosureEntry {
    pub index: u64,
    pub subject: Pubkey,
    pub requested_by: Pubkey,
    pub created_at: i64,
    pub effective_at: i64,
    pub reason_code: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FaucetRecord {
    pub wallet: Pubkey,
    pub last_drip: i64,
    pub bump: u8,
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, eusd_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    // The protocol can only be trusted to issue and redeem if it actually holds both mint
    // authorities. Check it here rather than taking the deployer's word for it.
    #[account(
        mint::token_program = token_program,
        constraint = eusd_mint.mint_authority == COption::Some(config.key())
            @ PaperError::MintAuthorityNotHeld,
    )]
    pub eusd_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mint::token_program = token_program,
        constraint = test_usdc_mint.mint_authority == COption::Some(config.key())
            @ PaperError::MintAuthorityNotHeld,
    )]
    pub test_usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump,
        token::mint = test_usdc_mint,
        token::authority = config,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AttestIdentity<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account()]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + IdentityRecord::INIT_SPACE,
        seeds = [IDENTITY_SEED, config.key().as_ref(), wallet.as_ref()],
        bump
    )]
    pub identity: Account<'info, IdentityRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RevokeIdentity<'info> {
    pub signer: Signer<'info>,
    #[account()]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [IDENTITY_SEED, config.key().as_ref(), wallet.as_ref()],
        bump = identity.bump
    )]
    pub identity: Account<'info, IdentityRecord>,
}

#[derive(Accounts)]
pub struct FaucetDrip<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    #[account()]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        address = config.test_usdc_mint,
        mint::token_program = token_program
    )]
    pub test_usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = test_usdc_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = recipient,
        space = 8 + FaucetRecord::INIT_SPACE,
        seeds = [FAUCET_SEED, config.key().as_ref(), recipient.key().as_ref()],
        bump
    )]
    pub faucet_record: Account<'info, FaucetRecord>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintEusd<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account()]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [IDENTITY_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = identity.bump,
        constraint = identity.wallet == user.key() @ PaperError::NotVerified
    )]
    pub identity: Account<'info, IdentityRecord>,
    #[account(mut, address = config.eusd_mint, mint::token_program = token_program)]
    pub eusd_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.test_usdc_mint, mint::token_program = token_program)]
    pub test_usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = test_usdc_mint, token::authority = user)]
    pub user_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.vault, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = eusd_mint, token::authority = user)]
    pub user_eusd: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RedeemEusd<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account()]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [IDENTITY_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = identity.bump,
        constraint = identity.wallet == user.key() @ PaperError::NotVerified
    )]
    pub identity: Account<'info, IdentityRecord>,
    #[account(mut, address = config.eusd_mint, mint::token_program = token_program)]
    pub eusd_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = config.test_usdc_mint, mint::token_program = token_program)]
    pub test_usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = test_usdc_mint, token::authority = user)]
    pub user_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = config.vault, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = eusd_mint, token::authority = user)]
    pub user_eusd: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RecordDisclosure<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = signer,
        space = 8 + DisclosureEntry::INIT_SPACE,
        seeds = [DISCLOSURE_SEED, config.key().as_ref(), config.disclosure_count.to_le_bytes().as_ref()],
        bump
    )]
    pub entry: Account<'info, DisclosureEntry>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events and errors

#[event]
pub struct IdentityAttested {
    pub wallet: Pubkey,
    pub partner: Pubkey,
}

#[event]
pub struct IdentityRevoked {
    pub wallet: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct FaucetDripped {
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Minted {
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Redeemed {
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisclosureRecorded {
    pub index: u64,
    pub subject: Pubkey,
    pub reason_code: u8,
}

#[error_code]
pub enum PaperError {
    #[msg("Signer is not the KYC authority for this registry")]
    NotKycAuthority,
    #[msg("Signer is not the protocol authority")]
    NotAuthority,
    #[msg("Wallet is not in the Identity Whitelist Registry")]
    NotVerified,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("The faucet allows one drip per wallet per day")]
    FaucetCooldown,
    #[msg("The protocol config is not the mint authority of this mint")]
    MintAuthorityNotHeld,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}

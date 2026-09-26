# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- `initialize` verifies that the config PDA is the mint authority of both the eUSD mint and the
  test-USDC mint, instead of taking the deployer's word for it.
- `Config` carries a layout `version` and a `created_at` timestamp.
- A `FaucetDripped` event.
- Tests for the mint-authority check, for redemption by an unverified wallet, and for the rule that
  a revoked wallet cannot re-attest itself.

### Changed
- Self-attestation can no longer undo a revocation; only the KYC partner can put a wallet back.
- Clock and counter arithmetic is checked rather than implicit.
- The vault carries the same token-program constraint as every other token account.

## 2026-09-22

First working prototype on devnet: faucet, identity registry, 1:1 mint and redeem against a vault,
confidential transfers with an auditor, a disclosure register with a 24-hour delay, and the Sentinel
transfer hook enforcing a blocklist on the same transfer that hides the amount.

# Security

**This is a devnet prototype. The tokens have no value, the programs have not been audited
independently, and nothing here should be used with real money.**

## Reporting

Write to hello@softseco.com. Please do not open a public issue for a vulnerability that affects a
deployed program. A reply comes within three working days.

## What the design assumes

- **The auditor sees amounts, the public does not.** A mint designates one auditor ElGamal key.
  Every confidential transfer encrypts the amount to the sender, the receiver and that auditor. The
  auditor key therefore reads every amount on the mint. It is a powerful key; in the production
  design it is held off-chain by the issuer and moves to threshold key-sharing across separate
  hardware modules.
- **Addresses stay public.** Token-2022 hides amounts, not the transaction graph. Anyone can see
  that two addresses transacted.
- **The KYC partner sees identity, not payments.** It writes an entry into the registry at the
  perimeter and learns nothing about what a wallet does afterwards.
- **Compliance is enforced on-chain.** A blocked address is refused by Token-2022 calling Sentinel,
  not by the interface. Bypassing the front end does not bypass the policy.

## Known limits of this prototype

- `allow_self_attest` lets a wallet enter the registry on its own. It exists so a visitor can try
  the flow on devnet and has no place in a real deployment. A wallet that has been revoked cannot
  use it to come back — only the KYC partner can.
- The faucet mints test USDC without limit, so the "reserve" behind the vault is itself a test
  token. The invariant the demo checks is between the issued eUSD and the vault, not against
  anything real.
- The upgrade authority of both programs is a single key.
- A confidential balance cannot be redeemed yet: moving value from a confidential balance back to a
  public one needs a withdraw path the TypeScript SDK does not have.
- Neither program has been independently audited.

## Dependencies

The programs are built with Anchor 0.31.1 and platform-tools v1.57. See CONTRIBUTING.md for why
those versions and not the defaults.

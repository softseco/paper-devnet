# PAPER devnet

A working devnet prototype of the PAPER Protocol: a dollar token whose amounts are encrypted
on-chain, whose mint and redeem are gated by an identity registry, whose transfers are checked by an
on-chain compliance policy, and whose disclosures to an auditor are recorded in public.

> **Devnet only. Every token here is a test token with no value, and nothing on this page is an
> offer of anything.**

## What it shows

Identity is checked at the mint and redeem perimeter only. Between those two points the token moves
through Token-2022 confidential transfers, so the protocol does not know who holds what — and a
recipient needs no identity record at all to be paid.

One run of `scripts/demo.ts` walks the whole story on public devnet:

1. a faucet hands out test USDC
2. a simulated KYC partner writes a wallet into the Identity Whitelist Registry
3. the wallet deposits test USDC into the reserve vault and receives eUSD one for one
4. half of it moves into a confidential balance
5. a confidential transfer sends it to a second wallet, amount encrypted on-chain
6. the mint's designated auditor decrypts that amount — and nobody else can
7. a disclosure is recorded in a public register, effective 24 hours later
8. the first wallet redeems its remaining eUSD back out of the vault
9. seven guards are proved by trying to break them, and each refuses

Every step checks the reserve invariant: eUSD issued always equals test USDC held, confidential
balances included.

## On devnet

| | |
|---|---|
| `paper` program | [`7twaRXVbxhiv9TZnjdbZQjkc9sQYXjbEgu5UWaFbt4zH`](https://explorer.solana.com/address/7twaRXVbxhiv9TZnjdbZQjkc9sQYXjbEgu5UWaFbt4zH?cluster=devnet) |
| Sentinel (compliance hook) | [`5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`](https://explorer.solana.com/address/5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD?cluster=devnet) |

## The program

| Instruction | What it is for |
|---|---|
| `initialize` | Config for one token: the eUSD mint, the test-USDC mint, the reserve vault, the KYC partner, the auditor. |
| `attest_identity` | The KYC partner marks a wallet as verified. On devnet a wallet may attest for itself. |
| `revoke_identity` | Closes the gate for a wallet without touching its balance. |
| `faucet_drip` | Mints test USDC to any wallet, once a day. |
| `mint_eusd` | A verified wallet deposits test USDC into the vault and receives eUSD 1:1. |
| `redeem_eusd` | A verified wallet burns eUSD and takes test USDC back 1:1. |
| `record_disclosure` | Writes a disclosure to the public register, effective 24 hours later. |

## Built on

Two packages released **before** this hackathon, and disclosed as prior work:

- [`@softseco/confidential-transfers`](https://github.com/softseco/confidential-sdk) — Token-2022
  confidential transfers in TypeScript and Rust, including auditor selective disclosure.
- [`sentinel`](https://github.com/softseco/sentinel) — programmable compliance through a Token-2022
  transfer hook: allowlist, blocklist, per-transfer limit.

Work done during the hackathon: this program, this demo, the tests, and transfer-hook account
resolution for confidential transfers in the SDK (2.1.0), without which a confidential transfer on a
mint with a hook fails with `MissingAccount`.

## Run it

```bash
anchor build --no-idl -- --tools-version v1.57   # the flag is not valid in the IDL step
anchor idl build -o target/idl/paper.json        # so the IDL is built separately
anchor test --skip-build --provider.cluster localnet   # 7 tests, no devnet needed
npx tsx scripts/demo.ts                          # the full story, against devnet
```

The demo needs about 1.5 devnet SOL and a dedicated RPC endpoint (`DEVNET_RPC` / `DEVNET_WS`); the
public one refuses websocket connections partway through.

## What is deliberately not real here

- **The faucet mints test USDC out of thin air.** There is no reserve behind the reserve; the vault
  holds test tokens, and the invariant the demo checks is between them.
- **"Simulate KYC" lets a wallet vouch for itself.** That path exists so a visitor can try the flow,
  and it is the one thing in this repository that has no place in a real deployment.
- **The auditor and the KYC partner are the same key as the deployer** in the demo run. In the
  design they are separate parties.
- **A confidential balance cannot be redeemed yet.** Moving value back from a confidential balance to
  a public one needs a withdraw path the TypeScript SDK does not have yet.
- **Nothing here has been independently audited**, and the program's upgrade authority is a single
  key.

## License

Apache-2.0.

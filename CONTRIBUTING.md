# Contributing

## Toolchain

The versions matter here, and the defaults do not work:

| Tool | Version | Why |
|---|---|---|
| Anchor | 0.31.1 | matches `anchor-lang` in the program |
| platform-tools | v1.57 | the default v1.43 has no SBF target for edition-2024 dependencies |
| Solana CLI | 2.3 or newer | older `cargo-build-sbf` pulls the wrong platform-tools |
| Node | 20 or newer | |

## Building

```bash
anchor build --no-idl -- --tools-version v1.57
anchor idl build -o target/idl/paper.json -t target/types/paper.ts
```

The IDL is built as its own step because `--tools-version` is forwarded to the IDL step's
`cargo test`, where it is not a valid argument.

## Testing

```bash
anchor test --skip-build --provider.cluster localnet
```

The suite runs against a local validator, needs no devnet SOL, and is what CI runs. A confirmed
transaction can be one slot ahead of a read, so balance assertions poll rather than read once.

## The devnet demo

```bash
npx tsx scripts/demo.ts
```

It needs about 1.5 devnet SOL and a dedicated RPC endpoint (`DEVNET_RPC` and `DEVNET_WS`); the
public endpoint refuses websocket connections partway through a run.

## Style

`cargo fmt --all` and `cargo clippy --all-targets -- -D warnings` both have to be clean; CI checks
them before it builds anything.

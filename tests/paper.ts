// SPDX-License-Identifier: Apache-2.0
//
// The program's own tests. These run on a local validator, so they cost nothing and can run in CI.
// Confidential transfers are not exercised here — they need the ZK ElGamal proof program and are
// covered end to end by scripts/demo.ts against devnet.
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAccount,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

const DECIMALS = 6;
const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));

describe("paper", () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.paper as Program<anchor.Idl>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let eusd: PublicKey;
  let testUsdc: PublicKey;
  let config: PublicKey;
  let vault: PublicKey;

  const alice = Keypair.generate();
  const mallory = Keypair.generate();

  const identityOf = (w: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("identity"), config.toBuffer(), w.toBuffer()], program.programId)[0];
  const faucetOf = (w: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("faucet"), config.toBuffer(), w.toBuffer()], program.programId)[0];
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  const faucetFor = (who: Keypair) =>
    program.methods
      .faucetDrip()
      .accountsPartial({
        recipient: who.publicKey,
        config,
        testUsdcMint: testUsdc,
        recipientToken: ata(testUsdc, who.publicKey),
        faucetRecord: faucetOf(who.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();

  const mintFor = (who: Keypair, amount: BN) =>
    program.methods
      .mintEusd(amount)
      .accountsPartial({
        user: who.publicKey,
        config,
        identity: identityOf(who.publicKey),
        eusdMint: eusd,
        testUsdcMint: testUsdc,
        userUsdc: ata(testUsdc, who.publicKey),
        vault,
        userEusd: ata(eusd, who.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([who])
      .rpc();

  const balanceOf = async (account: PublicKey) =>
    BigInt((await connection.getTokenAccountBalance(account)).value.amount);

  async function expectFailure(promise: Promise<unknown>, code: string) {
    try {
      await promise;
    } catch (err) {
      expect(`${(err as Error).message}`).to.include(code);
      return;
    }
    throw new Error(`expected this to fail with ${code}`);
  }

  before(async () => {
    for (const who of [alice, mallory]) {
      const sig = await connection.requestAirdrop(who.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    const eusdKeypair = Keypair.generate();
    config = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), eusdKeypair.publicKey.toBuffer()], program.programId)[0];
    vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), config.toBuffer()], program.programId)[0];
    eusd = await createMint(connection, payer, config, null, DECIMALS, eusdKeypair,
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    testUsdc = await createMint(connection, payer, config, null, DECIMALS, Keypair.generate(),
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  });

  it("initializes the protocol config and its vault", async () => {
    await program.methods
      .initialize(payer.publicKey, payer.publicKey, true)
      .accountsPartial({
        authority: payer.publicKey,
        config,
        eusdMint: eusd,
        testUsdcMint: testUsdc,
        vault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await (program.account as any).config.fetch(config);
    expect(state.eusdMint.toBase58()).to.equal(eusd.toBase58());
    expect(state.vault.toBase58()).to.equal(vault.toBase58());
    expect(state.disclosureCount.toNumber()).to.equal(0);
    expect(await balanceOf(vault)).to.equal(0n);
  });

  it("gives out test USDC once a day and no more", async () => {
    await faucetFor(alice);
    expect(await balanceOf(ata(testUsdc, alice.publicKey))).to.equal(1_000_000_000n);
    await expectFailure(faucetFor(alice), "FaucetCooldown");
  });

  it("refuses to mint for a wallet that is not in the registry", async () => {
    await faucetFor(mallory);
    await createAccount(connection, payer, eusd, mallory.publicKey, undefined,
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    await expectFailure(mintFor(mallory, unit(10)), "AccountNotInitialized");
  });

  it("mints one for one against the vault once the wallet is verified", async () => {
    await program.methods
      .attestIdentity(alice.publicKey)
      .accountsPartial({
        signer: alice.publicKey,
        config,
        identity: identityOf(alice.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();
    await createAccount(connection, payer, eusd, alice.publicKey, undefined,
      { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);

    await mintFor(alice, unit(100));
    expect(await balanceOf(vault)).to.equal(100_000_000n);
    expect(await balanceOf(ata(eusd, alice.publicKey))).to.equal(100_000_000n);
    const supply = (await getMint(connection, eusd, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    expect(supply).to.equal(await balanceOf(vault));
    await expectFailure(mintFor(alice, new BN(0)), "ZeroAmount");
  });

  it("redeems back out of the vault, keeping the reserve exact", async () => {
    await program.methods
      .redeemEusd(unit(40))
      .accountsPartial({
        user: alice.publicKey,
        config,
        identity: identityOf(alice.publicKey),
        eusdMint: eusd,
        testUsdcMint: testUsdc,
        userUsdc: ata(testUsdc, alice.publicKey),
        vault,
        userEusd: ata(eusd, alice.publicKey),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();
    const supply = (await getMint(connection, eusd, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    expect(await balanceOf(vault)).to.equal(60_000_000n);
    expect(supply).to.equal(60_000_000n);
  });

  it("records a disclosure, and only for the authority", async () => {
    const index = (await (program.account as any).config.fetch(config)).disclosureCount as BN;
    const entry = PublicKey.findProgramAddressSync(
      [Buffer.from("disclosure"), config.toBuffer(), index.toArrayLike(Buffer, "le", 8)],
      program.programId)[0];

    await expectFailure(
      program.methods
        .recordDisclosure(alice.publicKey, 1)
        .accountsPartial({ signer: mallory.publicKey, config, entry, systemProgram: SystemProgram.programId })
        .signers([mallory])
        .rpc(),
      "NotAuthority",
    );

    await program.methods
      .recordDisclosure(alice.publicKey, 1)
      .accountsPartial({ signer: payer.publicKey, config, entry, systemProgram: SystemProgram.programId })
      .rpc();
    const recorded = await (program.account as any).disclosureEntry.fetch(entry);
    expect(recorded.subject.toBase58()).to.equal(alice.publicKey.toBase58());
    expect(recorded.effectiveAt.toNumber() - recorded.createdAt.toNumber()).to.equal(86_400);
  });

  it("stops a revoked wallet at the perimeter without touching its balance", async () => {
    const before = await balanceOf(ata(eusd, alice.publicKey));
    await program.methods
      .revokeIdentity(alice.publicKey)
      .accountsPartial({ signer: payer.publicKey, config, identity: identityOf(alice.publicKey) })
      .rpc();
    await expectFailure(mintFor(alice, unit(10)), "NotVerified");
    expect(await balanceOf(ata(eusd, alice.publicKey))).to.equal(before);
  });
});

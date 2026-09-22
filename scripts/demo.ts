// SPDX-License-Identifier: Apache-2.0
//
// PAPER devnet — the whole story in one run.
//
//   faucet -> simulated KYC -> mint eUSD 1:1 -> confidential transfer -> auditor reads it -> redeem
//
// Devnet only. Every token here is a test token with no value.
//
//   npx tsx scripts/demo.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  createMint as splCreateMint,
  setAuthority,
  createTransferCheckedWithTransferHookInstruction,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getInitializeTransferHookInstruction,
  getMintSize,
} from "@solana-program/token-2022";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  lamports,
  none,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  applyPendingBalance,
  configureAccount,
  decryptBalance,
  decryptTransferAmountAsAuditor,
  deposit,
  deriveAuditorElgamalKeypair,
  getAuditorElgamalPubkey,
  transfer,
} from "@softseco/confidential-transfers";

import idl from "../target/idl/paper.json";
import sentinelIdl from "../idl/sentinel.json";

// ---------------------------------------------------------------- setup

const RPC_URL = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const RPC_WS_URL = process.env.DEVNET_WS ?? "wss://api.devnet.solana.com";
const DECIMALS = 6;
const unit = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS));
const fmt = (n: bigint) => (Number(n) / 10 ** DECIMALS).toFixed(2);

// The public devnet endpoint rate-limits hard; retry on 429 the way it asks.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  for (let attempt = 0; ; attempt++) {
    const res = await (realFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
    if (res.status !== 429 || attempt >= 8) return res;
    const wait = (Number(res.headers.get("retry-after") ?? 2) + attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
}) as typeof fetch;

const rpc = createSolanaRpc(RPC_URL);
const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const connection = new Connection(RPC_URL, "confirmed");

/** One identity usable by both client stacks: Anchor (web3.js) and the SDK (kit). */
type Actor = { name: string; web3: Keypair; kit: KeyPairSigner; key: PublicKey; addr: Address };

async function actor(name: string, keypair = Keypair.generate()): Promise<Actor> {
  return {
    name,
    web3: keypair,
    kit: await createKeyPairSignerFromBytes(keypair.secretKey),
    key: keypair.publicKey,
    addr: address(keypair.publicKey.toBase58()),
  };
}

function cliWallet(): Keypair {
  const path = process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

async function sendKit(payer: TransactionSigner, instructions: Instruction[]): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  await sendAndConfirm(await signTransactionMessageWithSigners(message), { commitment: "confirmed" });
}

/** The transfer-hook extension: some client versions take plain addresses, some take options. */
function hookExtension(authority: Address, programId: Address) {
  try {
    return extension("TransferHook", { authority, programId } as never);
  } catch {
    return extension("TransferHook", { authority: some(authority), programId: some(programId) } as never);
  }
}

function hookInit(mint: Address, authority: Address, programId: Address): Instruction {
  try {
    return getInitializeTransferHookInstruction({ mint, authority, programId } as never);
  } catch {
    return getInitializeTransferHookInstruction({
      mint, authority: some(authority), programId: some(programId),
    } as never);
  }
}

/** A Token-2022 mint, optionally with the confidential-transfer extension and an auditor. */
async function createMint(
  payer: Actor,
  mint: Actor,
  mintAuthority: PublicKey,
  confidential: { auditor: Address; hook: Address } | null,
): Promise<PublicKey> {
  const extensions = confidential
    ? [
        hookExtension(payer.addr, confidential.hook),
        extension("ConfidentialTransferMint", {
          authority: some(address(mintAuthority.toBase58())),
          autoApproveNewAccounts: true,
          auditorElgamalPubkey: some(confidential.auditor),
        }),
      ]
    : [];
  const space = BigInt(getMintSize(extensions));
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const instructions: Instruction[] = [
    getCreateAccountInstruction({
      payer: payer.kit,
      newAccount: mint.kit,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
  ];
  if (confidential) {
    // Extensions are initialised before the mint itself, hook first.
    instructions.push(
      hookInit(mint.addr, payer.addr, confidential.hook),
    );
    instructions.push(
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.addr,
        authority: some(address(mintAuthority.toBase58())),
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: some(confidential.auditor),
      }),
    );
  }
  instructions.push(
    getInitializeMint2Instruction({
      mint: mint.addr,
      decimals: DECIMALS,
      mintAuthority: address(mintAuthority.toBase58()),
      freezeAuthority: none(),
    }),
  );
  await sendKit(payer.kit, instructions);
  return mint.key;
}

/** Public devnet drops websocket connections under load; give each step a few tries. */
async function retry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`   (${label} failed, retrying in 6s)`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

// Set once main() has derived them, so the helpers below can read the chain.
let eusdMintKey: PublicKey;
let vaultKey: PublicKey;

/** The reserve claim, checked rather than asserted: every eUSD in existence is backed by a test USDC
 *  in the vault. Confidential balances count towards supply, so this holds even while amounts are hidden. */
async function backing(label: string): Promise<void> {
  const supply = BigInt((await connection.getTokenSupply(eusdMintKey)).value.amount);
  const held = BigInt((await connection.getTokenAccountBalance(vaultKey)).value.amount);
  const state = supply === held ? "fully backed" : "BROKEN";
  console.log(`   backing ${label}: ${fmt(supply)} eUSD issued / ${fmt(held)} test USDC in reserve — ${state}`);
  if (supply !== held) throw new Error(`reserve invariant broken: supply ${supply} != vault ${held}`);
}

/** A guard is only a guard if it refuses. Each of these must fail, with the error we expect. */
async function mustFail(label: string, fn: () => Promise<unknown>, expected: string): Promise<void> {
  let succeeded = false;
  try {
    await fn();
    succeeded = true;
  } catch (err) {
    const text = [
      (err as { message?: string }).message ?? String(err),
      JSON.stringify((err as { logs?: string[] }).logs ?? []),
      JSON.stringify((err as { context?: unknown }).context ?? {}),
      JSON.stringify((err as { cause?: { context?: unknown } }).cause?.context ?? {}),
    ].join(" ");
    if (text.includes(expected)) {
      console.log(`   ok   ${label}  (${expected})`);
    } else {
      console.log(`   HUH  ${label} — rejected, but not with ${expected}`);
      console.log(`        ${text.slice(0, 180)}`);
    }
  }
  if (succeeded) throw new Error(`guard did not hold: ${label}`);
}

// ---------------------------------------------------------------- the run

async function main() {
  const payer = await actor("payer", cliWallet());
  const provider = new AnchorProvider(connection, new Wallet(payer.web3), { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const pid = program.programId;

  // The config and its vault are derived from the token they govern, so a fresh run of this
  // demo mints a fresh eUSD and gets its own config rather than colliding with the last one.
  const eusdMintKp = await actor("eUSD mint");
  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), eusdMintKp.key.toBuffer()], pid);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), config.toBuffer()], pid);
  eusdMintKey = eusdMintKp.key;
  vaultKey = vault;
  const identityOf = (w: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("identity"), config.toBuffer(), w.toBuffer()], pid)[0];
  const faucetOf = (w: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("faucet"), config.toBuffer(), w.toBuffer()], pid)[0];
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  console.log("program:", pid.toBase58());
  console.log("payer:  ", payer.key.toBase58());
  const balance = await connection.getBalance(payer.key);
  console.log("balance:", (balance / 1e9).toFixed(2), "SOL");
  if (balance < 1.2e9) throw new Error("payer needs at least ~1.2 SOL on devnet");

  const [alice, bob, auditor] = await Promise.all([actor("Alice"), actor("Bob"), actor("Auditor")]);
  console.log("\nactors");
  console.log("  Alice  ", alice.key.toBase58());
  console.log("  Bob    ", bob.key.toBase58());
  console.log("  Auditor", auditor.key.toBase58());

  await sendKit(payer.kit, [
    getTransferSolInstruction({ source: payer.kit, destination: alice.addr, amount: lamports(150_000_000n) }),
    getTransferSolInstruction({ source: payer.kit, destination: bob.addr, amount: lamports(150_000_000n) }),
  ]);

  // The auditor's ElGamal key comes from its wallet, so it never has to be stored anywhere.
  const auditorKeypair = await deriveAuditorElgamalKeypair(auditor.kit);
  const auditorPubkey = getAuditorElgamalPubkey(auditorKeypair);

  console.log("\n0) mints");
  const testUsdc = await splCreateMint(
    connection, payer.web3, config, null, DECIMALS, undefined,
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID,
  );
  const sentinel = new Program(sentinelIdl as Idl, provider);
  const policyPda = PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), eusdMintKp.key.toBuffer()], sentinel.programId)[0];
  const metaListPda = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), eusdMintKp.key.toBuffer()], sentinel.programId)[0];
  const blockEntryOf = (w: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("block"), eusdMintKp.key.toBuffer(), w.toBuffer()], sentinel.programId)[0];

  const eusd = await createMint(payer, eusdMintKp, payer.key, {
    auditor: auditorPubkey,
    hook: address(sentinel.programId.toBase58()),
  });
  console.log("   test USDC:", testUsdc.toBase58());
  console.log("   eUSD:     ", eusd.toBase58(), "(confidential, auditor designated, Sentinel hook)");

  console.log("\n0b) Sentinel — the compliance policy that Token-2022 will call on every transfer");
  await sentinel.methods
    .initializePolicy(false, true, new BN(unit(500).toString()), true)
    .accountsPartial({
      authority: payer.key,
      mint: eusd,
      policyConfig: policyPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await sentinel.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      payer: payer.key,
      extraAccountMetaList: metaListPda,
      mint: eusd,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("   sentinel:", sentinel.programId.toBase58());
  console.log("   policy: blocklist on, limit 500.00 per transfer, confidential transfers allowed");

  // Now the mint passes to the protocol: from here only the program can issue eUSD.
  await setAuthority(connection, payer.web3, eusd, payer.web3, AuthorityType.MintTokens, config,
    [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  console.log("   mint authority handed to the protocol config");

  console.log("\n1) initialize — the protocol config, the reserve vault, the KYC partner, the auditor");
  await program.methods
    .initialize(payer.key, auditor.key, true)
    .accountsPartial({
      authority: payer.key,
      config,
      eusdMint: eusd,
      testUsdcMint: testUsdc,
      vault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("   config:", config.toBase58(), " vault:", vault.toBase58());

  console.log("\n2) faucet — Alice takes 1000 test USDC");
  await program.methods
    .faucetDrip()
    .accountsPartial({
      recipient: alice.key,
      config,
      testUsdcMint: testUsdc,
      recipientToken: ata(testUsdc, alice.key),
      faucetRecord: faucetOf(alice.key),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([alice.web3])
    .rpc();

  console.log("\n3) simulated KYC — Alice enters the Identity Whitelist Registry");
  await program.methods
    .attestIdentity(alice.key)
    .accountsPartial({
      signer: alice.key,
      config,
      identity: identityOf(alice.key),
      systemProgram: SystemProgram.programId,
    })
    .signers([alice.web3])
    .rpc();

  console.log("\n4) confidential accounts for Alice and Bob");
  await configureAccount({ rpc, rpcSubscriptions, payer: payer.kit, owner: alice.kit, mint: address(eusd.toBase58()) });
  await configureAccount({ rpc, rpcSubscriptions, payer: payer.kit, owner: bob.kit, mint: address(eusd.toBase58()) });
  console.log("   Bob has no identity record — he never needed one to receive");

  console.log("\n5) mint — Alice deposits 100 test USDC into the reserve and receives 100 eUSD");
  await program.methods
    .mintEusd(new BN(unit(100).toString()))
    .accountsPartial({
      user: alice.key,
      config,
      identity: identityOf(alice.key),
      eusdMint: eusd,
      testUsdcMint: testUsdc,
      userUsdc: ata(testUsdc, alice.key),
      vault,
      userEusd: ata(eusd, alice.key),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([alice.web3])
    .rpc();
  await backing("after mint");

  console.log("\n6) Alice moves 50 eUSD into her confidential balance");
  await deposit({
    rpc, rpcSubscriptions, payer: payer.kit, owner: alice.kit,
    mint: address(eusd.toBase58()), amount: unit(50), decimals: DECIMALS,
  });
  await retry("apply pending balance", () => applyPendingBalance({ rpc, rpcSubscriptions, payer: payer.kit, owner: alice.kit, mint: address(eusd.toBase58()) }));
  console.log("   Alice confidential:", fmt(await decryptBalance({ rpc, owner: alice.kit, mint: address(eusd.toBase58()) })));

  console.log("\n7) confidential transfer — 50 eUSD from Alice to Bob, amount encrypted on-chain");
  const { signatures } = await transfer({
    rpc, rpcSubscriptions, payer: payer.kit, owner: alice.kit,
    mint: address(eusd.toBase58()), destinationOwner: bob.addr,
    amount: unit(50), auditorElgamalPubkey: auditorPubkey,
  });
  for (const s of signatures) console.log("   https://explorer.solana.com/tx/" + s + "?cluster=devnet");
  await retry("apply pending balance", () => applyPendingBalance({ rpc, rpcSubscriptions, payer: payer.kit, owner: bob.kit, mint: address(eusd.toBase58()) }));
  console.log("   Bob confidential:  ", fmt(await decryptBalance({ rpc, owner: bob.kit, mint: address(eusd.toBase58()) })));
  console.log("   Alice confidential:", fmt(await decryptBalance({ rpc, owner: alice.kit, mint: address(eusd.toBase58()) })));

  await backing("after the confidential transfer");
  console.log("\n8) the auditor reads the amount nobody else can");
  let seen: bigint | null = null;
  for (const s of signatures) {
    try {
      seen = await decryptTransferAmountAsAuditor({ rpc, signature: s, auditorKeypair });
      break;
    } catch {
      /* the transfer spans several transactions; only one carries the ciphertext */
    }
  }
  console.log("   auditor decrypts:", seen === null ? "not found" : fmt(seen), "eUSD");

  console.log("\n9) disclosure register — recorded now, effective in 24 hours");
  const index = (await (program.account as any).config.fetch(config)).disclosureCount as BN;
  const [entry] = PublicKey.findProgramAddressSync(
    [Buffer.from("disclosure"), config.toBuffer(), index.toArrayLike(Buffer, "le", 8)],
    pid,
  );
  await program.methods
    .recordDisclosure(bob.key, 1)
    .accountsPartial({ signer: payer.key, config, entry, systemProgram: SystemProgram.programId })
    .rpc();
  const recorded = await (program.account as any).disclosureEntry.fetch(entry);
  console.log("   entry", recorded.index.toString(), "subject", recorded.subject.toBase58(),
    "effective", new Date(recorded.effectiveAt.toNumber() * 1000).toISOString());

  console.log("\n10) redeem — Alice burns her remaining 50 public eUSD and takes the USDC back");
  await program.methods
    .redeemEusd(new BN(unit(50).toString()))
    .accountsPartial({
      user: alice.key,
      config,
      identity: identityOf(alice.key),
      eusdMint: eusd,
      testUsdcMint: testUsdc,
      userUsdc: ata(testUsdc, alice.key),
      vault,
      userEusd: ata(eusd, alice.key),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .signers([alice.web3])
    .rpc();
  await backing("after redeem");

  console.log("\n11) the guards, proved by trying to break them");
  const mallory = await actor("Mallory");
  await sendKit(payer.kit, [
    getTransferSolInstruction({ source: payer.kit, destination: mallory.addr, amount: lamports(120_000_000n) }),
  ]);

  const faucetFor = (who: Actor) =>
    program.methods
      .faucetDrip()
      .accountsPartial({
        recipient: who.key,
        config,
        testUsdcMint: testUsdc,
        recipientToken: ata(testUsdc, who.key),
        faucetRecord: faucetOf(who.key),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who.web3])
      .rpc();

  const mintFor = (who: Actor, amount: bigint) =>
    program.methods
      .mintEusd(new BN(amount.toString()))
      .accountsPartial({
        user: who.key,
        config,
        identity: identityOf(who.key),
        eusdMint: eusd,
        testUsdcMint: testUsdc,
        userUsdc: ata(testUsdc, who.key),
        vault,
        userEusd: ata(eusd, who.key),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([who.web3])
      .rpc();

  await faucetFor(mallory);
  await configureAccount({
    rpc, rpcSubscriptions, payer: payer.kit, owner: mallory.kit, mint: address(eusd.toBase58()),
  });

  console.log("   Sentinel: putting Mallory on the blocklist for this mint");
  await sentinel.methods
    .addToBlocklist()
    .accountsPartial({
      authority: payer.key,
      mint: eusd,
      policyConfig: policyPda,
      wallet: mallory.key,
      blockEntry: blockEntryOf(mallory.key),
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await mintFor(alice, unit(10));
  await mustFail(
    "a blocked wallet cannot receive, and the chain itself refuses",
    async () => {
      const ix = await createTransferCheckedWithTransferHookInstruction(
        connection,
        ata(eusd, alice.key),
        eusd,
        ata(eusd, mallory.key),
        alice.key,
        unit(1),
        DECIMALS,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      return sendAndConfirmTransaction(connection, new Transaction().add(ix), [alice.web3], {
        commitment: "confirmed",
      });
    },
    "RecipientBlocked",
  );

  const setPolicy = (allowConfidential: boolean) =>
    sentinel.methods
      .updatePolicy(false, true, new BN(unit(500).toString()), allowConfidential)
      .accountsPartial({ authority: payer.key, mint: eusd, policyConfig: policyPda })
      .rpc();

  await setPolicy(false);
  await mustFail(
    "with the policy opted out, Sentinel refuses a transfer whose amount it cannot see",
    () =>
      transfer({
        rpc, rpcSubscriptions, payer: payer.kit, owner: bob.kit,
        mint: address(eusd.toBase58()), destinationOwner: alice.addr,
        amount: unit(1), auditorElgamalPubkey: auditorPubkey,
      }),
    "ConfidentialAmountNotEnforceable",
  );
  await setPolicy(true);
  console.log("   policy restored: confidential transfers allowed again");

  await mustFail(
    "a wallet that never passed KYC cannot mint",
    () => mintFor(mallory, unit(10)),
    "AccountNotInitialized",
  );
  await mustFail("the faucet refuses a second drip the same day", () => faucetFor(alice), "FaucetCooldown");
  await mustFail("minting nothing is rejected", () => mintFor(alice, 0n), "ZeroAmount");

  const nextIndex = (await (program.account as any).config.fetch(config)).disclosureCount as BN;
  const [strangerEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("disclosure"), config.toBuffer(), nextIndex.toArrayLike(Buffer, "le", 8)],
    pid,
  );
  await mustFail(
    "a stranger cannot write to the disclosure register",
    () =>
      program.methods
        .recordDisclosure(alice.key, 1)
        .accountsPartial({ signer: bob.key, config, entry: strangerEntry, systemProgram: SystemProgram.programId })
        .signers([bob.web3])
        .rpc(),
    "NotAuthority",
  );

  await program.methods
    .revokeIdentity(alice.key)
    .accountsPartial({ signer: payer.key, config, identity: identityOf(alice.key) })
    .rpc();
  await mustFail("a revoked wallet cannot mint", () => mintFor(alice, unit(10)), "NotVerified");
  console.log("   revoking Alice closed the door at the perimeter; it did not touch anyone's balance");

  await backing("after the guard tests");

  console.log("\nwhat just happened");
  console.log("  identity was checked only at mint and redeem; Bob received without one");
  console.log("  the transferred amount is ciphertext on-chain — the auditor read it, nobody else can");
  console.log("  every eUSD issued was matched by a test USDC in the vault at each step");
  console.log("  seven guards were checked by trying to break them, and each refused");
  console.log("  compliance is enforced by Token-2022 calling Sentinel, not by the front end");
  console.log("  eUSD mint:", "https://explorer.solana.com/address/" + eusd.toBase58() + "?cluster=devnet");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nFAILED");
    console.error(err);
    const logs = (err as { logs?: string[] }).logs;
    if (logs) console.error(logs.join("\n"));
    process.exit(1);
  },
);

// SPDX-License-Identifier: Apache-2.0
//
// Create — once — the deployment that the website talks to: one eUSD mint, one faucet, one vault,
// one disclosure register, shared by everyone who opens the devnet page.
//
//   npx tsx scripts/showcase.ts           verify the existing deployment, or create it
//   npx tsx scripts/showcase.ts --force   create a new one and overwrite showcase.json
//
// The auditor's wallet is kept outside the repository; only its ElGamal public key goes on-chain
// and into showcase.json. Whoever holds that wallet can read every amount on the mint.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BN } from "@coral-xyz/anchor";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createMint as splCreateMint,
  setAuthority,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { address } from "@solana/kit";
import { deriveAuditorElgamalKeypair, getAuditorElgamalPubkey } from "@softseco/confidential-transfers";

import {
  DECIMALS, actor, anchorProvider, cliWallet, connection, createConfidentialMint,
  explorer, fmt, pdas, programFrom, sentinelPdas, unit,
} from "./common";
import idl from "../target/idl/paper.json";
import sentinelIdl from "../idl/sentinel.json";

const FILE = join(__dirname, "..", "showcase.json");
const AUDITOR_KEY = process.env.PAPER_AUDITOR_KEYPAIR ?? join(homedir(), ".config", "solana", "paper-auditor.json");

type Showcase = {
  network: "devnet";
  paperProgram: string;
  sentinelProgram: string;
  eusdMint: string;
  testUsdcMint: string;
  config: string;
  vault: string;
  kycAuthority: string;
  auditorWallet: string;
  auditorElgamalPubkey: string;
  createdAt: string;
};

function auditorKeypair(): Keypair {
  if (!existsSync(AUDITOR_KEY)) {
    const fresh = Keypair.generate();
    writeFileSync(AUDITOR_KEY, JSON.stringify(Array.from(fresh.secretKey)), { mode: 0o600 });
    console.log("created an auditor wallet at", AUDITOR_KEY, "— keep it out of the repository");
    return fresh;
  }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(AUDITOR_KEY, "utf8")) as number[]));
}

async function report(showcase: Showcase): Promise<void> {
  const supply = await connection.getTokenSupply(new PublicKey(showcase.eusdMint));
  const vault = await connection.getTokenAccountBalance(new PublicKey(showcase.vault));
  console.log("\nshowcase deployment");
  for (const [label, value] of [
    ["paper program", showcase.paperProgram],
    ["sentinel", showcase.sentinelProgram],
    ["eUSD mint", showcase.eusdMint],
    ["test USDC", showcase.testUsdcMint],
    ["config", showcase.config],
    ["vault", showcase.vault],
  ] as const) {
    console.log(`  ${label.padEnd(14)} ${value}`);
  }
  console.log(`  issued         ${fmt(BigInt(supply.value.amount))} eUSD`);
  console.log(`  in reserve     ${fmt(BigInt(vault.value.amount))} test USDC`);
  console.log(`  explorer       ${explorer(showcase.eusdMint)}`);
}

async function main() {
  const force = process.argv.includes("--force");

  if (existsSync(FILE) && !force) {
    const existing = JSON.parse(readFileSync(FILE, "utf8")) as Showcase;
    const config = await connection.getAccountInfo(new PublicKey(existing.config));
    if (config) {
      console.log("showcase.json already points at a live deployment; nothing to do (--force to replace)");
      await report(existing);
      return;
    }
    console.log("showcase.json exists but its config account is gone — creating a new deployment");
  }

  const payer = await actor("payer", cliWallet());
  const provider = anchorProvider(payer.web3);
  const paper = programFrom(idl, provider);
  const sentinel = programFrom(sentinelIdl, provider);

  const balance = await connection.getBalance(payer.key);
  console.log("payer:", payer.key.toBase58(), (balance / 1e9).toFixed(2), "SOL");
  if (balance < 0.5e9) throw new Error("payer needs about 0.5 SOL on devnet");

  const auditor = await actor("auditor", auditorKeypair());
  const auditorElgamal = getAuditorElgamalPubkey(await deriveAuditorElgamalKeypair(auditor.kit));

  const eusdKeypair = await actor("eUSD mint");
  const { config, vault } = pdas(paper.programId, eusdKeypair.key);
  const sPdas = sentinelPdas(sentinel.programId, eusdKeypair.key);

  console.log("\n1) mints");
  const eusd = await createConfidentialMint(payer, eusdKeypair, payer.key, {
    auditor: auditorElgamal,
    hook: address(sentinel.programId.toBase58()),
  });
  const testUsdc = await splCreateMint(connection, payer.web3, config, null, DECIMALS, undefined,
    { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
  console.log("   eUSD     ", eusd.toBase58());
  console.log("   test USDC", testUsdc.toBase58());

  console.log("\n2) compliance policy");
  await sentinel.methods
    .initializePolicy(false, true, new BN(unit(500).toString()), true)
    .accountsPartial({
      authority: payer.key, mint: eusd, policyConfig: sPdas.policy,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await sentinel.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      payer: payer.key, extraAccountMetaList: sPdas.metaList, mint: eusd,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("   blocklist on, 500.00 per-transfer limit, confidential transfers allowed");

  console.log("\n3) hand the mint to the protocol");
  await setAuthority(connection, payer.web3, eusd, payer.web3, AuthorityType.MintTokens, config,
    [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);

  console.log("\n4) initialize");
  await paper.methods
    .initialize(payer.key, auditor.key, true)
    .accountsPartial({
      authority: payer.key, config, eusdMint: eusd, testUsdcMint: testUsdc, vault,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const showcase: Showcase = {
    network: "devnet",
    paperProgram: paper.programId.toBase58(),
    sentinelProgram: sentinel.programId.toBase58(),
    eusdMint: eusd.toBase58(),
    testUsdcMint: testUsdc.toBase58(),
    config: config.toBase58(),
    vault: vault.toBase58(),
    kycAuthority: payer.key.toBase58(),
    auditorWallet: auditor.key.toBase58(),
    auditorElgamalPubkey: auditorElgamal,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(FILE, JSON.stringify(showcase, null, 2) + "\n");
  console.log("\nwrote", FILE);
  await report(showcase);
  console.log("\nthe website reads these addresses; the auditor wallet stays at", AUDITOR_KEY);
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

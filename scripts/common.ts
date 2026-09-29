// SPDX-License-Identifier: Apache-2.0
//
// Shared plumbing for the devnet scripts: RPC wiring that survives a rate-limited public endpoint,
// identities usable by both client stacks, and the mint construction the protocol expects.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getCreateAccountInstruction } from "@solana-program/system";
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
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
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

export const DECIMALS = 6;
export const unit = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS));
export const fmt = (n: bigint) => (Number(n) / 10 ** DECIMALS).toFixed(2);
export const explorer = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

export const RPC_URL = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
export const RPC_WS_URL = process.env.DEVNET_WS ?? "wss://api.devnet.solana.com";

// The public devnet endpoint rate-limits hard; retry on 429 the way it asks rather than failing.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown) => {
  for (let attempt = 0; ; attempt++) {
    const res = await (realFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
    if (res.status !== 429 || attempt >= 8) return res;
    const wait = (Number(res.headers.get("retry-after") ?? 2) + attempt) * 1000;
    console.log(`   (rate limited, waiting ${wait} ms)`);
    await new Promise((r) => setTimeout(r, wait));
  }
}) as typeof fetch;

export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(RPC_WS_URL);
export const connection = new Connection(RPC_URL, "confirmed");
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export const pause = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** Public devnet drops websocket connections under load; give each step a few tries. */
export async function retry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`   (${label} failed, retrying in 6s)`);
      await pause(6000);
    }
  }
}

/** One identity usable by both client stacks: Anchor (web3.js) and the SDK (kit). */
export type Actor = {
  name: string;
  web3: Keypair;
  kit: KeyPairSigner;
  key: PublicKey;
  addr: Address;
};

export async function actor(name: string, keypair = Keypair.generate()): Promise<Actor> {
  return {
    name,
    web3: keypair,
    kit: await createKeyPairSignerFromBytes(keypair.secretKey),
    key: keypair.publicKey,
    addr: address(keypair.publicKey.toBase58()),
  };
}

/** The keypair the Solana CLI uses, so scripts pay from the same wallet as the terminal. */
export function cliWallet(path = process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export async function sendKit(payer: TransactionSigner, instructions: Instruction[]): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendAndConfirm(signed, { commitment: "confirmed" });
}

export const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

export function anchorProvider(payer: Keypair): AnchorProvider {
  return new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
}

export const programFrom = (idl: unknown, provider: AnchorProvider) => new Program(idl as Idl, provider);

/** PDAs of the paper program. */
export const pdas = (programId: PublicKey, eusdMint: PublicKey) => {
  const config = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), eusdMint.toBuffer()], programId)[0];
  return {
    config,
    vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), config.toBuffer()], programId)[0],
    identityOf: (w: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("identity"), config.toBuffer(), w.toBuffer()], programId)[0],
    faucetOf: (w: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("faucet"), config.toBuffer(), w.toBuffer()], programId)[0],
    disclosureOf: (index: Buffer) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("disclosure"), config.toBuffer(), index], programId)[0],
  };
};

/** PDAs of the Sentinel program. */
export const sentinelPdas = (programId: PublicKey, mint: PublicKey) => ({
  policy: PublicKey.findProgramAddressSync([Buffer.from("policy"), mint.toBuffer()], programId)[0],
  metaList: PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()], programId)[0],
  blockEntryOf: (w: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("block"), mint.toBuffer(), w.toBuffer()], programId)[0],
});

// Some client versions take plain addresses for the transfer hook, some take options.
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

/**
 * Create a Token-2022 mint. With `confidential`, the mint carries the confidential-transfer
 * extension with a designated auditor and a transfer hook, in the order Token-2022 requires:
 * extensions first, then the mint itself.
 */
export async function createConfidentialMint(
  payer: Actor,
  mint: Actor,
  mintAuthority: PublicKey,
  confidential: { auditor: Address; hook: Address },
): Promise<PublicKey> {
  const extensions = [
    hookExtension(payer.addr, confidential.hook),
    extension("ConfidentialTransferMint", {
      authority: some(address(mintAuthority.toBase58())),
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: some(confidential.auditor),
    }),
  ];
  const space = BigInt(getMintSize(extensions));
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await sendKit(payer.kit, [
    getCreateAccountInstruction({
      payer: payer.kit,
      newAccount: mint.kit,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    hookInit(mint.addr, payer.addr, confidential.hook),
    getInitializeConfidentialTransferMintInstruction({
      mint: mint.addr,
      authority: some(address(mintAuthority.toBase58())),
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: some(confidential.auditor),
    }),
    getInitializeMint2Instruction({
      mint: mint.addr,
      decimals: DECIMALS,
      mintAuthority: address(mintAuthority.toBase58()),
      freezeAuthority: none(),
    }),
  ]);
  return mint.key;
}

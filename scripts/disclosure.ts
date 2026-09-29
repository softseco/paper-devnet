// SPDX-License-Identifier: Apache-2.0
//
// Disclosure commitments. The register on-chain never names who a disclosure is about: each entry
// holds SHA-256 over a domain tag, the entry index, the hash of the full disclosure record and a
// random salt. The issuer keeps the record and the salt; a supervisor or an auditor who is given
// them can recompute the commitment and see that it matches the entry.
//
//   commitment = SHA-256( "PAPER-DISCLOSURE-v1" || index as u64 LE || SHA-256(JCS(record)) || salt )
//
// JCS is the JSON canonicalization of RFC 8785: keys sorted, no whitespace, so the same record
// always hashes to the same bytes.
import { createHash, randomBytes } from "node:crypto";

export const DISCLOSURE_DOMAIN = "PAPER-DISCLOSURE-v1";

/** RFC 8785 canonical JSON for the plain values a disclosure record holds. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON: non-finite number");
    if (value === undefined || typeof value === "function" || typeof value === "bigint") {
      throw new Error(`canonical JSON: unsupported value ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** A fresh 32-byte salt. Without it, a short record could be guessed and checked against the hash. */
export const newSalt = (): Buffer => randomBytes(32);

export function disclosureCommitment(index: bigint | number, record: object, salt: Uint8Array): Buffer {
  if (salt.length !== 32) throw new Error("the salt must be 32 bytes");
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(index));
  const recordHash = createHash("sha256").update(canonicalJson(record), "utf8").digest();
  return createHash("sha256")
    .update(Buffer.from(DISCLOSURE_DOMAIN, "utf8"))
    .update(le)
    .update(recordHash)
    .update(salt)
    .digest();
}

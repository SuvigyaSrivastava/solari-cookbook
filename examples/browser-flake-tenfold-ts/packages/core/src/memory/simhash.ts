/**
 * A minimal 64-bit simhash over an aria snapshot's text, used to notice
 * when a page's structure has drifted enough that a remembered locator is
 * no longer trustworthy (§11.2: "compute the current aria-snapshot simhash;
 * if Hamming distance to `fingerprint` <= threshold ... reuse").
 *
 * This is deliberately not a cryptographic hash: simhash's whole point is
 * that SIMILAR inputs produce hashes with a SMALL Hamming distance, so a
 * page with one renamed button still looks "close" to its old fingerprint,
 * while a page that's been substantially restructured looks "far." A
 * word-shingling simhash over the tokenized snapshot text is enough for
 * that job without pulling in a dependency.
 */

const BITS = 64;

/** djb2, extended to a BigInt so we can fill all 64 bits deterministically. */
function hashToken(token: string): bigint {
  let h = 5381n;
  for (let i = 0; i < token.length; i++) {
    h = (h * 33n + BigInt(token.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Returns the fingerprint as a lowercase hex string (16 chars = 64 bits). */
export function simhash(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "0".repeat(16);

  const bitWeights = new Array<number>(BITS).fill(0);
  for (const token of tokens) {
    const h = hashToken(token);
    for (let bit = 0; bit < BITS; bit++) {
      const isSet = (h >> BigInt(bit)) & 1n;
      bitWeights[bit] = (bitWeights[bit] ?? 0) + (isSet ? 1 : -1);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < BITS; bit++) {
    if ((bitWeights[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint.toString(16).padStart(16, "0");
}

/** Hamming distance between two hex-encoded 64-bit fingerprints. */
export function hammingDistance(hexA: string, hexB: string): number {
  const a = BigInt(`0x${hexA}`);
  const b = BigInt(`0x${hexB}`);
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

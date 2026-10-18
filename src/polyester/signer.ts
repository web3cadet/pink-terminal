import { createHash, createPrivateKey, sign as signBytes } from "node:crypto";

const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalizeQuery(query: string): string {
  const raw = query.startsWith("?") ? query.slice(1) : query;
  if (!raw) return "";
  const pairs = [...new URLSearchParams(raw).entries()];
  pairs.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  return pairs.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join("&");
}

export function bodySha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function buildCanonicalString(input: {
  timestampMs: string;
  method: string;
  path: string;
  query?: string;
  body: string;
}): string {
  return [
    input.timestampMs,
    input.method.toUpperCase(),
    input.path,
    canonicalizeQuery(input.query ?? ""),
    bodySha256Hex(input.body)
  ].join("\n");
}

export function signEd25519Hex(canonical: string, secretSeedHex: string): string {
  const seed = Buffer.from(secretSeedHex.replace(/^0x/i, ""), "hex");
  if (seed.length !== 32) throw new Error("Ed25519 secret must be a 32-byte seed");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
  return signBytes(null, Buffer.from(canonical, "utf8"), privateKey).toString("hex");
}

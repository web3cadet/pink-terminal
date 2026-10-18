import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bodySha256Hex, buildCanonicalString, canonicalizeQuery, signEd25519Hex } from "../src/polyester/signer.js";

describe("Polyester request signing", () => {
  it("matches the documented query normalization", () => {
    expect(canonicalizeQuery("tag=z&q=hello+world&literal=%2B&tag=a&empty=")).toBe("empty=&literal=%2B&q=hello%20world&tag=a&tag=z");
  });

  it("uses the known empty-body SHA-256", () => {
    expect(bodySha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("creates a verifiable Ed25519 signature", () => {
    const seedHex = "11".repeat(32);
    const body = JSON.stringify({ symbolId: 1 });
    const canonical = buildCanonicalString({ timestampMs: "1791852268000", method: "post", path: "/test.Service/Method", body });
    const signature = Buffer.from(signEd25519Hex(canonical, seedHex), "hex");
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]),
      format: "der",
      type: "pkcs8"
    });
    expect(signature).toHaveLength(64);
    expect(verify(null, Buffer.from(canonical), createPublicKey(privateKey), signature)).toBe(true);
  });
});

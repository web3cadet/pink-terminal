import { describe, expect, it } from "vitest";
import { decodeBase58Uint64, encodeBase58Uint64 } from "../src/utils/base58.js";

describe("public IDs", () => {
  it.each(["0", "1", "281474977629551", "18446744073709551615"])("round-trips %s", (value) => {
    expect(decodeBase58Uint64(encodeBase58Uint64(value))).toBe(value);
  });

  it("rejects ambiguous base58 characters", () => {
    expect(() => decodeBase58Uint64("0OIl")).toThrow(/Invalid base58/);
  });
});

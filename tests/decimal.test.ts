import { describe, expect, it } from "vitest";
import { compareDecimals, decimalToScaled, isStepAligned, multiplyDecimals, scaledToDecimal } from "../src/utils/decimal.js";

describe("decimal math", () => {
  it("converts without floating point", () => {
    expect(decimalToScaled("0.00000001", 8)).toBe("1");
    expect(decimalToScaled("81362.81", 9)).toBe("81362810000000");
    expect(scaledToDecimal("81362810000000", 9)).toBe("81362.81");
  });

  it("rejects precision loss", () => {
    expect(() => decimalToScaled("1.000000001", 8)).toThrow(/Too many decimals/);
  });

  it("compares and multiplies exact decimal strings", () => {
    expect(compareDecimals("5.00", "5")).toBe(0);
    expect(multiplyDecimals("0.25", "100", 8)).toBe("25");
    expect(isStepAligned("0.002", "0.001")).toBe(true);
    expect(isStepAligned("0.0025", "0.001")).toBe(false);
  });
});

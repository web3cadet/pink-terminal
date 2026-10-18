import { describe, expect, it } from "vitest";
import { redactLogValue } from "../src/log.js";

describe("secret-safe logging", () => {
  it("redacts Telegram tokens and 32-byte hex seeds even inside URLs", () => {
    const value = redactLogValue("https://api.telegram.org/bot1234567890:abcdefghijklmnopqrstuvwxyzABCDE/getMe seed=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(value).not.toContain("1234567890:");
    expect(value).not.toContain("a".repeat(64));
    expect(value).toContain("[REDACTED_TELEGRAM_TOKEN]");
    expect(value).toContain("[REDACTED_32_BYTE_HEX]");
  });
});

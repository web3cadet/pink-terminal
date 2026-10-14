import { describe, expect, it } from "vitest";
import { orderKindCard, orderKindKeyboard } from "../src/bot/ui.js";

describe("order type card", () => {
  it("explains every execution option in plain language", () => {
    const card = orderKindCard("AVAX-USDT", "BUY");

    expect(card).toContain("AVAX / USDT");
    expect(card).toContain("🟢 BUY");
    expect(card).toContain("stays open until filled or cancelled");
    expect(card).toContain("stays open until the time you set");
    expect(card).toContain("fills what is available now; cancels the rest");
    expect(card).toContain("fills the entire amount now or nothing");
  });

  it("keeps one clear action per row and valid callback sizes", () => {
    const rows = orderKindKeyboard().inline_keyboard;

    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.length === 1)).toBe(true);
    const callbackData = rows.flat().flatMap((button) => "callback_data" in button ? [button.callback_data] : []);
    for (const value of callbackData) expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(64);
  });
});

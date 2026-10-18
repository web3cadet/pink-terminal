import { describe, expect, it } from "vitest";
import { amountPrompt, orderSettingsCard, strategyPrompt } from "../src/bot/card-copy.js";
import { formatOrderDraft, orderKindCard, sparkline } from "../src/bot/ui.js";
import { orderMinimums } from "../src/bot/order-context.js";
import type { OrderDraft, PairConfig, TriggerDraft } from "../src/domain.js";

describe("concise, asset-aware card copy", () => {
  for (const quote of ["USDT", "USDC", "BTC"]) for (const side of ["BUY", "SELL"] as const) for (const quoteMode of [true, false]) {
    it(`${quote} ${side} ${quoteMode ? "quote" : "base"}: keeps the amount and percentage units distinct`, () => {
      const pair = { symbol: `ETH-${quote}`, baseAsset: "ETH", quoteAsset: quote } as PairConfig;
      const text = amountPrompt(pair, { side }, quoteMode);
      expect(text).toContain(`available <b>${side === "BUY" ? quote : "ETH"}</b>`);
      expect(text).toContain(quoteMode ? `value in <b>${quote}</b>` : "<b>ETH</b> quantity");
      expect(text).toContain(side === "BUY" ? "Percentages: fees are included in the budget." : "Fees reduce the proceeds.");
      if (quote !== "USDT") expect(text).not.toContain("USDT");
    });
  }
  it("does not confuse quantity minimum with order value", () => {
    expect(orderMinimums({ minQtyBase: "0.1", minNotionalQuote: "5", stepSize: "0.01", baseAsset: "ETH", quoteAsset: "USDC" } as PairConfig))
      .toContain("Min. quantity: <b>0.1 ETH</b>\nMin. order value: <b>5 USDC</b>");
  });
  it("shows only supported optional settings and selected risk values", () => {
    const limit = orderSettingsCard({ symbol: "ETH-USDC", side: "BUY", kind: "LIMIT_GTC", attachedRisk: { takeProfitPrice: "2500" } });
    expect(limit).toContain("Take-profit: 2500 USDC");
    expect(limit).toContain("Post-only: OFF");
    expect(limit).not.toContain("Max. slippage:");
    const market = orderSettingsCard({ symbol: "ETH-USDC", kind: "MARKET_IOC", maxSlippageBps: 100 });
    expect(market).toContain("Max. slippage: 100 bps");
    expect(market).not.toContain("Post-only:");
  });
  it("keeps strategy context on every input without promising percentage input", () => {
    for (const kind of ["TWAP", "LADDER", "STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP"] as const) {
      const text = strategyPrompt({ kind, side: "SELL", symbol: "ETH-USDC" } as TriggerDraft, "Total quantity", "Enter the {base} quantity. Price is in {quote}.");
      expect(text).toContain("SELL ETH / USDC");
      expect(text).toContain("Enter the ETH quantity. Price is in USDC.");
      expect(text).not.toContain("percentage");
    }
  });
  it("keeps budget fee semantics and does not invent a quantity", () => {
    const card = formatOrderDraft({ symbol: "ETH-USDC", side: "BUY", kind: "MARKET_IOC", maxQuoteDebit: "50", quoteAmount: "50", balancePercent: "10", percentageAsset: "USDC" });
    expect(card).toContain("Budget: <b>50 USDC</b> (including fees)");
    expect(card).toContain("Quantity: calculated by Polyester within the budget");
    expect(card).not.toContain("Fees are additional");
    expect(card).not.toContain("excluding fees");
  });
  it("escapes asset names and values in HTML copy", () => {
    const card = strategyPrompt({ kind: "TWAP", symbol: "A&B-Q<X", side: "BUY" }, "Amount", "Enter {base} in {quote}.");
    expect(card).toContain("A&amp;B"); expect(card).toContain("Q&lt;X");
    expect(card).not.toContain("Q<X");
  });
  it("uses a real data-dependent sparkline and keeps all execution modes", () => {
    expect(sparkline([1, 2, 3, 4])).toBe("▁▃▆█");
    expect(sparkline([4, 3, 2, 1])).toBe("█▆▃▁");
    expect(sparkline([])).toBe("—");
    const text = orderKindCard("ETH-USDC", "SELL");
    for (const label of ["Market", "Limit", "GTC", "GTD", "IOC", "FOK"]) expect(text).toContain(label);
    expect(text).not.toContain("STEP 3 OF 5");
  });
});

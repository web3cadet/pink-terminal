import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, MarketOverview, SpotCatalog } from "../src/domain.js";
import { renderTerminalSnapshot } from "../src/bot/bot.js";
import { mainKeyboard } from "../src/bot/ui.js";

const config: AppConfig = {
  telegramToken: "test", allowedChatIds: new Set([1]), allowedUserIds: new Set(),
  apiUrl: "https://api.testnet.polyester.com", tradingMode: "paper", confirmationTtlSeconds: 90,
  databasePath: ":memory:", pollIntervalMs: 15_000, logLevel: "error"
};

const pairs = Array.from({ length: 18 }, (_, index) => ({
  symbolId: index + 1, symbol: `ASSET${index + 1}-USDT`, baseAsset: `ASSET${index + 1}`, quoteAsset: "USDT",
  tickSize: "0.01", stepSize: "0.001", minNotionalQuote: "5", minQtyBase: "0.001", baseQuantityScale: 3,
  quoteQuantityScale: 6, referencePriceScale: 6, status: "PAIR_STATUS_ENABLED",
  defaultMarketSlippageBpsBuy: 200, defaultMarketSlippageBpsSell: 200, maxClientRefDriftBps: 100
}));
const catalog: SpotCatalog = { assets: [], pairs, tsSec: "1" };
const overview: MarketOverview[] = pairs.map((pair) => ({
  symbolId: pair.symbolId, lastPrice: `${100 + pair.symbolId}.25`, change24hBps: pair.symbolId,
  high24h: null, low24h: null, volume24hBase: null, volume24hQuote: null, bestBid: null, bestAsk: null, indexPrice: null
}));
const gateway = {
  getCatalog: async () => catalog,
  listMarketOverview: async () => overview,
  listBalances: async () => [],
  listOpenOrders: async () => []
} as unknown as ExchangeGateway;

describe("Telegram terminal view", () => {
  it("paginates markets into compact screens without losing any pair", async () => {
    const seen = new Set<string>();
    for (const page of [0, 1, 2]) {
      const snapshot = await renderTerminalSnapshot(gateway, config, true, page);
      expect(snapshot.text.length).toBeLessThanOrEqual(4096);
      expect(snapshot.text).not.toContain("AVAILABLE");
      expect(snapshot.text).not.toContain("OPEN ORDERS");
      expect(snapshot.text).toContain("$");
      const labels = snapshot.keyboard.inline_keyboard.flat().map(button => button.text);
      expect(labels).not.toContain("▶ Live prices");
      expect(labels).not.toContain("■ Pause");
      for (const button of snapshot.keyboard.inline_keyboard.flat()) {
        if ("callback_data" in button) {
          expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
          if (button.callback_data.startsWith("pair:")) seen.add(button.text.replace("/", "-"));
        }
      }
    }
    expect(seen).toEqual(new Set(pairs.map(pair => pair.symbol)));
  });

  it("uses one trading entry instead of duplicate Markets and Create order actions", () => {
    const labels = mainKeyboard(false).inline_keyboard.flat().map(button => button.text);
    expect(labels).toContain("📈 Trading");
    expect(labels).toContain("📋 Open orders");
    expect(labels).toContain("🗂 Order history");
    expect(labels).not.toContain("🟢 Create order");
    expect(labels).not.toContain("📊 Markets & trading");
  });
});

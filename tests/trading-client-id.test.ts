import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, OrderDraft, TriggerDraft } from "../src/domain.js";
import { Logger } from "../src/log.js";
import { TradingService } from "../src/services/trading.js";
import { AppDatabase } from "../src/storage/database.js";

const pair = { symbolId: 1, symbol: "HYPE-USDT", baseAsset: "HYPE", quoteAsset: "USDT", status: "PAIR_STATUS_ENABLED", minQtyBase: "0.01", minNotionalQuote: "5", stepSize: "0.01", tickSize: "0.01" };
const config = { tradingMode: "live", confirmationTtlSeconds: 90 } as AppConfig;

describe("Polyester client identifiers", () => {
  it("keeps order and strategy IDs within the API's 36-character limit", async () => {
    let previewClientId = "";
    const gateway = {
      getCatalog: async () => ({ pairs: [pair], assets: [] }), listMarketOverview: async () => [{ symbolId: 1, lastPrice: "10" }],
      previewOrder: async (_draft: OrderDraft, clientId: string) => { previewClientId = clientId; return { admissible: true, raw: {} }; }
    } as unknown as ExchangeGateway;
    const db = new AppDatabase(":memory:");
    const service = new TradingService(config, gateway, db, new Logger("error"));
    try {
      const order = await service.prepareOrder(1, 1, { symbolId: 1, symbol: "HYPE-USDT", side: "BUY", kind: "MARKET_IOC", maxQuoteDebit: "5" });
      const strategy = await service.prepareTrigger(1, 1, { symbolId: 1, symbol: "HYPE-USDT", kind: "STOP_LOSS", side: "SELL", qty: "1", triggerPrice: "9", childKind: "MARKET_IOC" } as TriggerDraft);
      for (const id of [previewClientId, order.clientId, strategy.clientId]) {
        expect(id.length).toBeLessThanOrEqual(36);
        expect(id).toMatch(/^[a-z]+-[0-9a-f]+$/);
      }
    } finally { db.close(); }
  });
});

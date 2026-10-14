import { it, expect } from "vitest";
import { renderOverview } from "../src/bot/overview.js";
import type { ExchangeGateway } from "../src/domain.js";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/storage/database.js";

it("values trading plus funding without double-counting reserved funds and never invents PnL or volume", async () => {
  const gateway = {
    getCatalog: async () => ({
      assets: [
        { ledgerId: 2, asset: "USDC" }, { ledgerId: 1, asset: "USDT" },
        { ledgerId: 3, asset: "ETH" }, { ledgerId: 4, asset: "MYST" }
      ],
      pairs: [
        { symbolId: 1, symbol: "TEST-USDT", baseAsset: "TEST", quoteAsset: "USDT" },
        { symbolId: 2, symbol: "USDC-USDT", baseAsset: "USDC", quoteAsset: "USDT" },
        { symbolId: 3, symbol: "ETH-USDC", baseAsset: "ETH", quoteAsset: "USDC" }
      ]
    }),
    listBalances: async () => [
      { assetId: 2, trading: "1000000000000000000", funding: "0", available: "1000000000000000000", reserved: "0" },
      { assetId: 3, trading: "1000000000000000000", funding: "0", available: "1000000000000000000", reserved: "0" },
      { assetId: 4, trading: "1000000000000000000", funding: "0", available: "1000000000000000000", reserved: "0" },
      { assetId: 1, trading: "100000000000000000000", funding: "20000000000000000000", available: "70000000000000000000", reserved: "30000000000000000000" }
    ],
    listMarketOverview: async () => [{ symbolId: 2, lastPrice: "1" }, { symbolId: 3, lastPrice: "2000" }],
    listOpenOrders: async () => [{ orderId: "open-1", clientOrderId: "tg-open", symbolId: 1, side: "BUY", status: "ORDER_STATUS_OPEN", leavesQty: "2", price: "5", raw: {} }],
    listTriggers: async () => [{ triggerId: "encoded", symbolId: 1, type: "LADDER", status: "TRIGGER_STATUS_ACTIVE", raw: { triggerId: "9001" } }]
  } as unknown as ExchangeGateway;
  const database = new AppDatabase(":memory:");
  database.recordBotFillVolume(7, "tg-order", "fill-1", "12.34");
  database.createIntent({ id: "order", chatId: 1, userId: 7, operation: "order", clientId: "tg-open", payload: { symbolId: 1 }, preview: {}, status: "accepted", expiresAt: Date.now() + 1_000 });
  database.createIntent({ id: "trigger", chatId: 1, userId: 7, operation: "trigger", clientId: "tr-local", payload: { symbolId: 1, kind: "LADDER", qty: "4", priceMin: "10", priceMax: "20" }, preview: null, status: "accepted", expiresAt: Date.now() + 1_000 });
  database.finishIntent("trigger", "accepted", { triggerId: "9001" }, null);
  const text = await renderOverview(gateway, { tradingMode: "read_only" } as AppConfig, database, 7);
  expect(text).toContain("Estimated value: <b>≈ 2,121 USDT</b>");
  expect(text).not.toContain("Partial valuation");
  expect(text).not.toContain("Not valued");
  expect(text).toContain("Open orders: <b>1</b>");
  expect(text).toContain("12.34 USDT");
  expect(text).toContain("<b>◈ PORTFOLIO</b>");
  expect(text).toContain("Volume: <b>12.34 USDT</b> <i>(filled via bot)</i>");
  expect(text).toContain("𝙋𝙄𝙉𝙆 𝙏𝙀𝙍𝙈𝙄𝙉𝘼𝙇\n<b>Terminal</b>\n");
  expect(text).toContain("<i>for Polyester testnet</i>");
  expect(text).not.toContain("<code>");
  expect(text).not.toContain("<blockquote>");
  expect(text).not.toContain("unrealized");
  expect(text).not.toContain("active strategies");
  expect(text).not.toContain("PnL");
  expect(text).not.toContain("cost basis unavailable");
  expect(text).toContain("\n\n");
  const balancesSection = text.slice(text.indexOf("<b>◉ TOP BALANCES</b>"));
  expect(balancesSection.indexOf("<b>USDT</b>")).toBeLessThan(balancesSection.indexOf("<b>USDC</b> ↗"));
  expect(balancesSection).not.toContain("USDC / USDT");
  database.close();
});

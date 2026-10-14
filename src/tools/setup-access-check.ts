import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";
import { checkAccess, renderAccessReport } from "../setup/access-check.js";

try {
  const config = loadConfig();
  if (config.tradingMode === "paper") throw new Error("Authenticated mode required");
  const gateway = new PolyesterGateway(config, new Logger("error"));
  const report = await checkAccess({
    balances: () => gateway.listBalances(),
    orders: () => gateway.listOpenOrders(),
    history: () => gateway.listOrderHistory(),
    strategies: () => gateway.listTriggers(),
    preview: async () => {
      if (config.tradingMode === "read_only") return { admissible: true, raw: {} };
      const [catalog, markets] = await Promise.all([gateway.getCatalog(), gateway.listMarketOverview()]);
      const pair = catalog.pairs.find(item => item.symbol === "HYPE-USDT" && item.status === "PAIR_STATUS_ENABLED")
        ?? catalog.pairs.find(item => item.quoteAsset === "USDT" && item.status === "PAIR_STATUS_ENABLED");
      if (!pair) throw new Error("No enabled USDT market");
      const market = markets.find(item => item.symbolId === pair.symbolId);
      return gateway.previewOrder({
        symbolId: pair.symbolId, symbol: pair.symbol, side: "BUY", kind: "MARKET_IOC",
        maxQuoteDebit: "10", maxSlippageBps: pair.defaultMarketSlippageBpsBuy,
        ...(market?.lastPrice ? { clientRefPrice: market.lastPrice } : {})
      }, randomUUID());
    }
  });
  console.log(renderAccessReport(report, config.tradingMode === "read_only"));
  if (!report.ok) process.exitCode = 1;
} catch {
  // Configuration errors may contain secret input; never dump them to the terminal.
  console.log("\nCould not check API access. Check your local configuration and connection, or choose 2 to replace the API key.");
  process.exitCode = 1;
}

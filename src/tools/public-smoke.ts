import type { AppConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";

const config: AppConfig = {
  telegramToken: "public-smoke-only",
  allowedChatIds: new Set(),
  allowedUserIds: new Set(),
  apiUrl: process.env.POLYESTER_API_URL ?? "https://api.testnet.polyester.com",
  tradingMode: "paper",
  confirmationTtlSeconds: 90,
  databasePath: ":memory:",
  pollIntervalMs: 15_000,
  logLevel: "error"
};

const gateway = new PolyesterGateway(config, new Logger("error"));
const catalog = await gateway.getCatalog(true);
const enabled = catalog.pairs.filter((pair) => pair.status === "PAIR_STATUS_ENABLED");
if (enabled.length === 0) throw new Error("No enabled Polyester markets returned");
const pair = enabled[0]!;
const [overview, book, candles] = await Promise.all([
  gateway.listMarketOverview(), gateway.getOrderbook(pair.symbolId, 5), gateway.getCandles(pair.symbolId, "1m", 3)
]);
if (!overview.some((market) => market.symbolId === pair.symbolId)) throw new Error("Selected market missing from overview");
if (book.bids.length === 0 && book.asks.length === 0) throw new Error("Order book is empty");
if (candles.length === 0) throw new Error("No candles returned");
console.log(JSON.stringify({
  ok: true,
  apiUrl: config.apiUrl,
  assets: catalog.assets.length,
  markets: catalog.pairs.length,
  enabledMarkets: enabled.length,
  sampledSymbol: pair.symbol,
  bids: book.bids.length,
  asks: book.asks.length,
  candles: candles.length
}, null, 2));

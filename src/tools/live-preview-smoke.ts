import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";

const config = loadConfig();
if (config.tradingMode !== "live") throw new Error("Live preview smoke requires TRADING_MODE=live");
const gateway = new PolyesterGateway(config, new Logger("error"));
const [catalog, markets] = await Promise.all([gateway.getCatalog(), gateway.listMarketOverview()]);
const pair = catalog.pairs.find(item => item.symbol === "HYPE-USDT") ?? catalog.pairs.find(item => item.quoteAsset === "USDT" && item.status === "PAIR_STATUS_ENABLED");
if (!pair) throw new Error("No enabled USDT pair available for preview");
const market = markets.find(item => item.symbolId === pair.symbolId);
const preview = await gateway.previewOrder({
  symbolId: pair.symbolId,
  symbol: pair.symbol,
  side: "BUY",
  kind: "MARKET_IOC",
  maxQuoteDebit: "10",
  maxSlippageBps: pair.defaultMarketSlippageBpsBuy,
  ...(market?.lastPrice ? { clientRefPrice: market.lastPrice } : {})
}, randomUUID());
console.log(JSON.stringify({
  ok: true,
  mode: config.tradingMode,
  pair: pair.symbol,
  previewReached: true,
  admissible: preview.admissible,
  rejectionCode: preview.rejectionCode ?? null,
  orderCreated: false
}, null, 2));

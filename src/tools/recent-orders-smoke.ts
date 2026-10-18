import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";

const gateway = new PolyesterGateway(loadConfig(), new Logger("error"));
const [catalog, history, open] = await Promise.all([gateway.getCatalog(), gateway.listOrderHistory(), gateway.listOpenOrders()]);
const names = new Map(catalog.pairs.map(pair => [pair.symbolId, pair.symbol]));
const recent = history.slice(0, 10).map(order => ({
  pair: names.get(order.symbolId) ?? `#${order.symbolId}`,
  side: order.side,
  status: order.status,
  quantity: order.totalQty ?? order.qty ?? null,
  filled: order.cumulativeQty ?? null,
  createdAt: order.createdAt ?? null
}));
const matchingDraft = history.filter(order => names.get(order.symbolId) === "AVAX-USDT" && order.side === "BUY" && (order.totalQty ?? order.qty) === "4");
console.log(JSON.stringify({ openOrders: open.length, matchingAvaxBuy4: matchingDraft.length, recent }, null, 2));

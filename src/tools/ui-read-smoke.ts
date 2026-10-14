import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";
import { ReadOnlyGateway } from "../polyester/read-only-gateway.js";
import { renderOverview } from "../bot/overview.js";
import { PolyesterApiError } from "../polyester/transport.js";

const config = loadConfig();
const gateway = new ReadOnlyGateway(new PolyesterGateway(config, new Logger("error")));
const catalog = await gateway.getCatalog();
const pair = catalog.pairs.find(p => p.symbol === "HYPE-USDT") ?? catalog.pairs[0]!;
const [overview, stats] = await Promise.allSettled([
  renderOverview(gateway, config),
  gateway.getAccountStats()
]);
console.log(JSON.stringify({
  overview: overview.status === "fulfilled" ? { ok: true, length: overview.value.length, withinTelegramLimit: overview.value.length <= 4096 } : { ok: false },
  volume30d: stats.status === "fulfilled" ? { endpointAvailable: true, metricReported: stats.value.volume30dUsd !== undefined } : { endpointAvailable: false, status: stats.reason instanceof PolyesterApiError ? stats.reason.status : "network", code: stats.reason instanceof PolyesterApiError ? stats.reason.code : "unknown" },
  writeOperations: 0
}, null, 2));
for (const [name, read] of Object.entries({ balances: () => gateway.listBalances(), markets: () => gateway.listMarketOverview(), book: () => gateway.getOrderbook(pair.symbolId, 5), candles: () => gateway.getCandles(pair.symbolId, "5m", 24) })) {
  try { await read(); console.log(JSON.stringify({ source: name, ok: true })); }
  catch (error) { console.log(JSON.stringify({ source: name, ok: false, status: error instanceof PolyesterApiError ? error.status : "network", code: error instanceof PolyesterApiError ? error.code : "unknown" })); }
}
if (overview.status === "rejected") process.exitCode = 1;

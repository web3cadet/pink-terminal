import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { PolyesterGateway } from "../polyester/gateway.js";
import { ReadOnlyGateway } from "../polyester/read-only-gateway.js";
import { PolyesterApiError } from "../polyester/transport.js";

const config = loadConfig();
if (config.tradingMode === "paper") throw new Error("Private read smoke requires TRADING_MODE=read_only or live");

const gateway = new ReadOnlyGateway(new PolyesterGateway(config, new Logger("error")));
const catalog = await gateway.getCatalog(true);
const [balances, openOrders, orderHistory, triggers] = await Promise.allSettled([
  gateway.listBalances(),
  gateway.listOpenOrders(),
  gateway.listOrderHistory(),
  gateway.listTriggers()
]);
const privateReadsOk = [balances, openOrders, orderHistory, triggers].every((result) => result.status === "fulfilled");

function failure(error: unknown): Record<string, unknown> {
  return error instanceof PolyesterApiError
    ? { ok: false, status: error.status, code: error.code ?? "unknown", message: error.message }
    : { ok: false, code: "unknown", message: error instanceof Error ? error.message : "Unknown error" };
}

console.log(JSON.stringify({
  ok: privateReadsOk,
  mode: config.tradingMode,
  assets: catalog.assets.length,
  balances: balances.status === "fulfilled" ? {
    ok: true,
    returned: balances.value.length,
    nonZero: balances.value.filter((balance) => balance.available !== "0" || balance.reserved !== "0" || balance.funding !== "0").length
  } : failure(balances.reason),
  openOrders: openOrders.status === "fulfilled" ? { ok: true, returned: openOrders.value.length } : failure(openOrders.reason),
  orderHistory: orderHistory.status === "fulfilled" ? { ok: true, returned: orderHistory.value.length } : failure(orderHistory.reason),
  triggers: triggers.status === "fulfilled" ? { ok: true, returned: triggers.value.length } : failure(triggers.reason),
  writeOperationsBlocked: true
}, null, 2));

if (!privateReadsOk) process.exitCode = 1;

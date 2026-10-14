import type { ExchangeGateway } from "../domain.js";
import type { AppConfig } from "../config.js";
import { scaledToDecimal } from "../utils/decimal.js";
import { assetLink, modeText, numberText, terminalHeading } from "./presentation.js";
import type { AppDatabase } from "../storage/database.js";

export async function renderOverview(gateway: ExchangeGateway, config: AppConfig, database?: AppDatabase, userId?: number): Promise<string> {
  const catalog = await gateway.getCatalog();
  const [balances, markets, orders] = await Promise.allSettled([
    gateway.listBalances(), gateway.listMarketOverview(), gateway.listOpenOrders()
  ]);
  let estimated = 0;
  const holdings: string[] = [];
  const marketRows = markets.status === "fulfilled" ? markets.value : [];
  const usdtPrices = buildUsdtPrices(catalog.pairs, marketRows);
  const orderedBalances = balances.status === "fulfilled"
    ? [...balances.value].sort((left, right) => {
      const leftSymbol = catalog.assets.find(asset => asset.ledgerId === left.assetId)?.asset;
      const rightSymbol = catalog.assets.find(asset => asset.ledgerId === right.assetId)?.asset;
      return Number(rightSymbol === "USDT") - Number(leftSymbol === "USDT");
    })
    : [];
  for (const balance of orderedBalances) {
    const total = BigInt(balance.trading) + BigInt(balance.funding);
    if (total === 0n) continue;
    const asset = catalog.assets.find(a => a.ledgerId === balance.assetId);
    const symbol = asset?.asset ?? `#${balance.assetId}`;
    const pair = symbol === "USDT" ? undefined
      : catalog.pairs.find(p => p.baseAsset === symbol && p.quoteAsset === "USDT")
        ?? catalog.pairs.find(p => p.baseAsset === symbol || p.quoteAsset === symbol);
    const price = usdtPrices.get(symbol) ?? NaN;
    const amount = scaledToDecimal(total.toString(), 18);
    if (Number.isFinite(price) && price > 0) estimated += Number(amount) * price;
    holdings.push(`${assetLink(symbol, pair?.symbol)}\n  Available <b>${numberText(scaledToDecimal(balance.available, 18))}</b> · Reserved ${numberText(scaledToDecimal(balance.reserved, 18))}`);
  }
  const localVolume = database && userId !== undefined ? database.getBotTradingVolume(userId) : "0";
  return [
    terminalHeading("Terminal"), "<i>for Polyester testnet</i>", modeText(config.tradingMode), "",
    "<b>◈ PORTFOLIO</b>",
    balances.status === "fulfilled" ? `Estimated value: <b>≈ ${numberText(estimated.toFixed(2), 2)} USDT</b>` : "Estimated value: <b>Unavailable</b>",
    `Volume: <b>${numberText(Number(localVolume).toFixed(2), 2)} USDT</b> <i>(filled via bot)</i>`,
    `Open orders: <b>${orders.status === "fulfilled" ? orders.value.length : "—"}</b>`,
    "",
    "<b>◉ TOP BALANCES</b>",
    holdings.length ? holdings.slice(0, 5).join("\n") : balances.status === "fulfilled" ? "No holdings yet" : "Unavailable",
    holdings.length > 5 ? `<i>${holdings.length - 5} more in Balances</i>` : ""
  ].join("\n");
}

function buildUsdtPrices(
  pairs: Awaited<ReturnType<ExchangeGateway["getCatalog"]>>["pairs"],
  markets: Awaited<ReturnType<ExchangeGateway["listMarketOverview"]>>
): Map<string, number> {
  const prices = new Map<string, number>([["USDT", 1]]);
  const marketPrices = new Map(markets.map(market => [market.symbolId, Number(market.lastPrice)]));
  for (let pass = 0; pass < pairs.length; pass++) {
    let changed = false;
    for (const pair of pairs) {
      const pairPrice = marketPrices.get(pair.symbolId);
      if (!Number.isFinite(pairPrice) || pairPrice! <= 0) continue;
      const basePrice = prices.get(pair.baseAsset);
      const quotePrice = prices.get(pair.quoteAsset);
      if (basePrice === undefined && quotePrice !== undefined) {
        prices.set(pair.baseAsset, pairPrice! * quotePrice);
        changed = true;
      } else if (quotePrice === undefined && basePrice !== undefined) {
        prices.set(pair.quoteAsset, basePrice / pairPrice!);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return prices;
}

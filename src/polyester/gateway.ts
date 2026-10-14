import type {
  Balance,
  Candle,
  ExchangeGateway,
  MarketOverview,
  OrderDraft,
  OrderDetails,
  OrderExecution,
  OrderPreview,
  OrderReceipt,
  OrderSummary,
  Orderbook,
  PairConfig,
  SpotCatalog,
  TriggerDraft,
  TriggerSummary
} from "../domain.js";
import type { Logger } from "../log.js";
import { decodeBase58Uint64, encodeBase58Uint64 } from "../utils/base58.js";
import { decimalToScaled, scaledToDecimal } from "../utils/decimal.js";
import type { AppConfig } from "../config.js";
import { asArray, asNumber, asRecord, asString, ConnectJsonTransport } from "./transport.js";

const PATHS = {
  spotConfig: "/marketdata.v1.MarketDataService/GetSpotConfig",
  candles: "/marketdata.v1.MarketDataService/GetCandles",
  overview: "/marketoverview.v1.MarketOverviewService/ListMarketOverview",
  orderbook: "/orderbook.v1.OrderbookService/GetOrderBook",
  balances: "/ledger.read.v1.LedgerReadService/GetBalances",
  previewOrder: "/orders.v1.OrdersService/PreviewOrder",
  createOrder: "/orders.v1.OrdersService/CreateOrder",
  openOrders: "/orders.v1.OrdersReadService/GetOpenOrders",
  orderHistory: "/orders.v1.OrdersReadService/GetOrderHistory",
  getOrder: "/orders.v1.OrdersReadService/GetOrder",
  cancelOrder: "/orders.v1.OrdersService/CancelOrder",
  cancelAll: "/orders.v1.OrdersService/CancelAllOrders",
  listTriggers: "/triggers.v1.TriggersService/ListTriggers",
  createTrigger: "/triggers.v1.TriggersService/CreateTrigger",
  cancelTrigger: "/triggers.v1.TriggersService/CancelTrigger",
  pauseTrigger: "/triggers.v1.TriggersService/PauseTrigger",
  resumeTrigger: "/triggers.v1.TriggersService/ResumeTrigger"
} as const;

const TIMEFRAMES: Record<string, string> = {
  "1s": "SEC_1", "1m": "MIN_1", "5m": "MIN_5", "15m": "MIN_15", "30m": "MIN_30",
  "1h": "HOUR_1", "4h": "HOUR_4", "12h": "HOUR_12", "1d": "DAY_1", "1w": "WEEK_1", "1mo": "MONTH_1"
};

const DEPTHS: Record<number, string> = {
  1: "DEPTH_1", 5: "DEPTH_5", 10: "DEPTH_10", 20: "DEPTH_20", 50: "DEPTH_50",
  100: "DEPTH_100", 200: "DEPTH_200", 500: "DEPTH_500", 1000: "DEPTH_1000"
};

export class PolyesterGateway implements ExchangeGateway {
  private readonly transport: ConnectJsonTransport;
  private catalogCache?: { value: SpotCatalog; expiresAt: number };

  constructor(private readonly config: AppConfig, logger: Logger) {
    const credentials = config.apiKeyId && config.apiSecretHex
      ? { keyId: config.apiKeyId, secretHex: config.apiSecretHex }
      : undefined;
    this.transport = new ConnectJsonTransport(config.apiUrl, credentials, logger);
  }

  async getCatalog(force = false): Promise<SpotCatalog> {
    if (!force && this.catalogCache && this.catalogCache.expiresAt > Date.now()) return this.catalogCache.value;
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.spotConfig, {}, { retryRead: true });
    const value: SpotCatalog = {
      assets: asArray(raw.assets).map((item) => {
        const row = asRecord(item);
        return {
          asset: asString(row.asset), ledgerId: asNumber(row.ledgerId), name: asString(row.name),
          quantityDisplayDecimals: asNumber(row.quantityDisplayDecimals), quantityScale: asNumber(row.quantityScale)
        };
      }),
      pairs: asArray(raw.pairs).map((item) => this.parsePair(asRecord(item))),
      tsSec: asString(raw.tsSec)
    };
    this.catalogCache = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }

  async listMarketOverview(): Promise<MarketOverview[]> {
    const [catalog, raw] = await Promise.all([
      this.getCatalog(),
      this.transport.call<Record<string, unknown>>(PATHS.overview, { limit: 100, includeSparklines: false }, { retryRead: true })
    ]);
    const pairs = new Map(catalog.pairs.map((pair) => [pair.symbolId, pair]));
    return asArray(raw.markets).map((item) => {
      const row = asRecord(item);
      const symbolId = asNumber(row.symbolId);
      const pair = pairs.get(symbolId);
      const priceScale = pair?.referencePriceScale ?? 9;
      const baseScale = pair?.baseQuantityScale ?? 0;
      const quoteScale = pair?.quoteQuantityScale ?? 0;
      return {
        symbolId,
        lastPrice: optionalScaled(row.lastPriceTicks, priceScale),
        change24hBps: row.change24hBps === undefined ? null : asNumber(row.change24hBps),
        high24h: optionalScaled(row.high24hTicks, priceScale),
        low24h: optionalScaled(row.low24hTicks, priceScale),
        volume24hBase: optionalScaled(row.volume24hBaseScaled, baseScale),
        volume24hQuote: optionalScaled(row.volume24hQuoteScaled, quoteScale),
        bestBid: optionalScaled(row.bestBidTicks, priceScale),
        bestAsk: optionalScaled(row.bestAskTicks, priceScale),
        indexPrice: optionalScaled(row.indexPriceTicks, priceScale)
      };
    });
  }

  async getOrderbook(symbolId: number, depth = 20): Promise<Orderbook> {
    const catalog = await this.getCatalog();
    const pair = requirePair(catalog, symbolId);
    const selectedDepth = nearestDepth(depth);
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.orderbook, {
      symbolId, depth: DEPTHS[selectedDepth]
    }, { retryRead: true });
    const levels = (value: unknown) => asArray(value).map((item) => {
      const row = asRecord(item);
      return {
        price: scaledToDecimal(asString(row.priceTicks, "0"), pair.referencePriceScale),
        qty: scaledToDecimal(asString(row.qtyScaled, "0"), pair.baseQuantityScale)
      };
    });
    return {
      symbolId,
      bookSeq: asString(raw.bookSeq),
      bids: levels(raw.bids),
      asks: levels(raw.asks),
      ts: asString(raw.ts)
    };
  }

  async getCandles(symbolId: number, timeframe: string, limit = 30): Promise<Candle[]> {
    const pair = requirePair(await this.getCatalog(), symbolId);
    const wireTimeframe = TIMEFRAMES[timeframe];
    if (!wireTimeframe) throw new Error(`Unsupported timeframe: ${timeframe}`);
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.candles, {
      symbolId, timeframe: wireTimeframe, limit: Math.max(1, Math.min(10_000, limit)), includeIncomplete: true
    }, { retryRead: true });
    return asArray(raw.candles).map((item) => {
      const row = asRecord(item);
      return {
        tsSec: asString(row.tsSec),
        open: scaledToDecimal(asString(row.open, "0"), pair.referencePriceScale),
        high: scaledToDecimal(asString(row.high, "0"), pair.referencePriceScale),
        low: scaledToDecimal(asString(row.low, "0"), pair.referencePriceScale),
        close: scaledToDecimal(asString(row.close, "0"), pair.referencePriceScale),
        volume: scaledToDecimal(asString(row.volume, "0"), pair.baseQuantityScale),
        quoteVolume: asString(row.quoteVolume, "0")
      };
    });
  }

  async listBalances(): Promise<Balance[]> {
    const body = this.scope({});
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.balances, body, { authenticated: true, retryRead: true });
    return asArray(raw.balances).map((item) => {
      const row = asRecord(item);
      return {
        assetId: asNumber(row.assetId), trading: readU128(row.trading), funding: readU128(row.funding),
        reserved: readU128(row.reserved), available: readU128(row.available)
      };
    });
  }

  async getAccountStats(): Promise<{ volume30dUsd?: string; asOf?: string }> {
    const raw = await this.transport.call<Record<string, unknown>>("/vip.v1.VIPService/GetVIPStatus", {}, { authenticated: true, retryRead: true });
    const result: { volume30dUsd?: string; asOf?: string } = {};
    if (typeof raw.settledVolume30dUsd === "string") result.volume30dUsd = raw.settledVolume30dUsd;
    if (typeof raw.metricsAsOf === "string") result.asOf = raw.metricsAsOf;
    return result;
  }

  async previewOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderPreview> {
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.previewOrder, await this.buildOrderRequest(draft, clientOrderId), {
      authenticated: true, retryRead: true
    });
    const rejection = asRecord(raw.rejection);
    const result: OrderPreview = { admissible: raw.admissible === true, raw };
    const rejectionCode = asString(rejection.code);
    const rejectionMessage = asString(rejection.message);
    const resolvedBaseQty = asString(raw.resolvedBaseQtyScaled) || asString(raw.resolvedBaseQty);
    const protectedPriceBound = asString(raw.protectedPriceBoundTicks) || asString(raw.protectedPriceBound);
    if (rejectionCode) result.rejectionCode = rejectionCode;
    if (rejectionMessage) result.rejectionMessage = rejectionMessage;
    if (resolvedBaseQty) result.resolvedBaseQty = resolvedBaseQty;
    if (protectedPriceBound) result.protectedPriceBound = protectedPriceBound;
    return result;
  }

  async createOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderReceipt> {
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.createOrder, await this.buildOrderRequest(draft, clientOrderId), {
      authenticated: true, timeoutMs: 12_000
    });
    const result: OrderReceipt = { clientOrderId: asString(raw.clientOrderId, clientOrderId), status: "accepted", raw };
    if (raw.orderId !== undefined) result.orderId = encodeBase58Uint64(asString(raw.orderId));
    const acceptedAt = asString(raw.acceptedAt);
    if (acceptedAt) result.acceptedAt = acceptedAt;
    return result;
  }

  async listOpenOrders(symbolId?: number): Promise<OrderSummary[]> {
    await this.getCatalog();
    return this.listOrders(PATHS.openOrders, symbolId);
  }

  async listOrderHistory(symbolId?: number): Promise<OrderSummary[]> {
    await this.getCatalog();
    return this.listOrders(PATHS.orderHistory, symbolId);
  }

  async getOrderByClientId(clientOrderId: string): Promise<OrderSummary | null> {
    await this.getCatalog();
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.getOrder, this.scope({
      clientOrderId, includeAttachedRisk: true, includeAttachedRiskState: true, includeExecutionHistory: true, limit: 100, pageToken: ""
    }), { authenticated: true, retryRead: true });
    const row = asRecord(raw.order);
    return Object.keys(row).length ? this.parseOrder(row) : null;
  }

  async getOrderDetails(orderId: string, pageToken = ""): Promise<OrderDetails | null> {
    await this.getCatalog();
    const raw = await this.transport.call<Record<string, unknown>>(PATHS.getOrder, this.scope({
      orderId: decodeBase58Uint64(orderId), includeAttachedRisk: true, includeAttachedRiskState: true,
      includeExecutionHistory: true, limit: 100, pageToken
    }), { authenticated: true, retryRead: true });
    const row = asRecord(raw.order);
    if (Object.keys(row).length === 0) return null;
    const pair = requirePair(await this.getCatalog(), asNumber(row.symbolId));
    const executions = asArray(raw.trades).map((item) => this.parseOrderExecution(asRecord(item), pair));
    const result: OrderDetails = {
      order: this.parseOrder(row),
      executions,
      executionCount: executions.length,
      transferCount: asArray(raw.transfers).length,
      raw
    };
    const nextPageToken = asString(raw.nextPageToken);
    if (nextPageToken) result.nextPageToken = nextPageToken;
    return result;
  }

  cancelOrder(clientOrderId: string, symbolId: number): Promise<Record<string, unknown>> {
    return this.transport.call(PATHS.cancelOrder, this.scope({ clientOrderId, symbolId }), { authenticated: true });
  }

  cancelAll(symbolIds: number[], dryRun: boolean, requestId: string): Promise<Record<string, unknown>> {
    return this.transport.call(PATHS.cancelAll, this.scope({ symbolIds, dryRun, requestId }), { authenticated: true });
  }

  async listTriggers(symbolId?: number): Promise<TriggerSummary[]> {
    const rows: unknown[] = [];
    let pageToken = "";
    const seen = new Set<string>();
    do {
      const raw = await this.transport.call<Record<string, unknown>>(PATHS.listTriggers, this.scope({
        symbolId: symbolId ?? 0, status: [], limit: 100, pageToken
      }), { authenticated: true, retryRead: true });
      rows.push(...asArray(raw.triggers));
      pageToken = asString(raw.nextPageToken);
      if (pageToken && (seen.has(pageToken) || seen.size >= 100)) throw new Error("Strategy pagination did not terminate");
      seen.add(pageToken);
    } while (pageToken);
    return rows.map((item): TriggerSummary => {
      const row = asRecord(item);
      const result: TriggerSummary = {
        triggerId: encodeBase58Uint64(asString(row.triggerId, "0")),
        symbolId: asNumber(row.symbolId),
        type: detectTriggerType(row),
        status: asString(row.status, "UNKNOWN"),
        raw: row
      };
      const clientTriggerId = asString(row.clientTriggerId);
      const side = asString(row.side) || asString(asRecord(row.stopLoss ?? row.takeProfit ?? row.trailingStop ?? row.twap ?? row.ladder).side);
      if (clientTriggerId) result.clientTriggerId = clientTriggerId;
      if (side) result.side = side;
      return result;
    });
  }

  async createTrigger(draft: TriggerDraft, clientTriggerId: string): Promise<Record<string, unknown>> {
    const pair = requirePair(await this.getCatalog(), draft.symbolId);
    const trigger: Record<string, unknown> = {
      symbolId: draft.symbolId,
      qtyScaled: decimalToScaled(draft.qty, pair.baseQuantityScale),
      feeAsset: draft.side === "SELL" ? "QUOTE" : "QUOTE",
      selfTradePreventionMode: "EXPIRE_MAKER",
      clientTriggerId
    };
    if (draft.kind === "STOP_LOSS" || draft.kind === "TAKE_PROFIT") {
      const child = draft.childKind === "LIMIT_GTC"
        ? { limitGtc: { priceTicks: decimalToScaled(requireValue(draft.childLimitPrice, "limit execution price"), pair.referencePriceScale), postOnly: draft.postOnly ?? false } }
        : { marketIoc: {} };
      trigger[draft.kind === "STOP_LOSS" ? "stopLoss" : "takeProfit"] = {
        triggerPriceTicks: decimalToScaled(requireValue(draft.triggerPrice, "trigger price"), pair.referencePriceScale),
        side: draft.side,
        child
      };
    } else if (draft.kind === "TRAILING_STOP") {
      trigger.trailingStop = {
        ...(draft.trailingBps !== undefined
          ? { trailingDistanceBps: draft.trailingBps }
          : { trailingDistanceTicks: decimalToScaled(requireValue(draft.trailingDistance, "trailing distance"), pair.referencePriceScale) }),
        ...(draft.activationPrice ? { activationPriceTicks: decimalToScaled(draft.activationPrice, pair.referencePriceScale) } : {}),
        ...(draft.maxSlippageBps ? { maxSlippageBps: draft.maxSlippageBps } : {}),
        side: draft.side
      };
    } else if (draft.kind === "TWAP") {
      trigger.twap = {
        side: draft.side,
        durationMs: String(draft.durationMs ?? 60_000),
        sliceIntervalMs: String(draft.sliceIntervalMs ?? 10_000),
        ...(draft.childKind === "LIMIT_GTC"
          ? { limitGtc: { priceTicks: decimalToScaled(requireValue(draft.childLimitPrice, "limit execution price"), pair.referencePriceScale) } }
          : { marketIoc: draft.maxSlippageBps ? { maxSlippageBps: draft.maxSlippageBps } : {} })
      };
    } else {
      trigger.ladder = {
        side: draft.side,
        priceMinTicks: decimalToScaled(requireValue(draft.priceMin, "minimum price"), pair.referencePriceScale),
        priceMaxTicks: decimalToScaled(requireValue(draft.priceMax, "maximum price"), pair.referencePriceScale),
        levels: draft.levels ?? 2,
        postOnly: draft.postOnly ?? false
      };
    }
    return this.transport.call(PATHS.createTrigger, this.scope({ trigger }), { authenticated: true });
  }

  cancelTrigger(triggerId: string, _symbolId: number): Promise<Record<string, unknown>> {
    return this.transport.call(PATHS.cancelTrigger, this.scope({ triggerId: decodeBase58Uint64(triggerId) }), { authenticated: true });
  }

  pauseTrigger(triggerId: string, _symbolId: number): Promise<Record<string, unknown>> {
    return this.transport.call(PATHS.pauseTrigger, this.scope({ triggerId: decodeBase58Uint64(triggerId) }), { authenticated: true });
  }

  resumeTrigger(triggerId: string, symbolId: number): Promise<Record<string, unknown>> {
    return this.transport.call(PATHS.resumeTrigger, this.scope({ triggerId: decodeBase58Uint64(triggerId), symbolId }), { authenticated: true });
  }

  private async buildOrderRequest(draft: OrderDraft, clientOrderId: string): Promise<Record<string, unknown>> {
    const pair = requirePair(await this.getCatalog(), draft.symbolId);
    const order: Record<string, unknown> = {
      symbolId: draft.symbolId,
      side: draft.side,
      clientOrderId,
      feeAsset: draft.side === "SELL" ? "QUOTE" : (draft.feeAsset ?? "QUOTE"),
      selfTradePreventionMode: "EXPIRE_MAKER"
    };
    if (draft.qty) order.baseQtyScaled = decimalToScaled(draft.qty, pair.baseQuantityScale);
    else order.maxQuoteDebitScaled = decimalToScaled(requireValue(draft.maxQuoteDebit, "order size"), pair.quoteQuantityScale);

    if (draft.kind === "MARKET_IOC") {
      order.marketIoc = {
        ...(draft.maxSlippageBps ? { maxSlippageBps: draft.maxSlippageBps } : {}),
        ...(draft.clientRefPrice ? { clientRefPriceTicks: decimalToScaled(draft.clientRefPrice, pair.referencePriceScale) } : {})
      };
    } else {
      const priceTicks = decimalToScaled(requireValue(draft.price, "limit price"), pair.referencePriceScale);
      if (draft.kind === "LIMIT_GTC") order.limitGtc = { priceTicks, postOnly: draft.postOnly ?? false };
      if (draft.kind === "LIMIT_GTD") order.limitGtd = { priceTicks, postOnly: draft.postOnly ?? false, expireAt: requireValue(draft.expireAt, "expiry") };
      if (draft.kind === "LIMIT_IOC") order.limitIoc = { priceTicks };
      if (draft.kind === "LIMIT_FOK") order.limitFok = { priceTicks };
    }
    const risk = draft.attachedRisk;
    if (risk && (risk.takeProfitPrice || risk.stopLossPrice || risk.trailingDistance || risk.trailingBps)) {
      const attached: Record<string, unknown> = {};
      if (risk.takeProfitPrice) attached.takeProfit = {
        triggerPriceTicks: decimalToScaled(risk.takeProfitPrice, pair.referencePriceScale), child: { marketIoc: {} }
      };
      if (risk.stopLossPrice) attached.stopLoss = {
        triggerPriceTicks: decimalToScaled(risk.stopLossPrice, pair.referencePriceScale), child: { marketIoc: {} }
      };
      if (risk.trailingDistance || risk.trailingBps) attached.trailingStop = {
        ...(risk.trailingBps ? { trailingDistanceBps: risk.trailingBps } : { trailingDistanceTicks: decimalToScaled(risk.trailingDistance!, pair.referencePriceScale) }),
        ...(risk.activationPrice ? { activationPriceTicks: decimalToScaled(risk.activationPrice, pair.referencePriceScale) } : {}),
        ...(draft.maxSlippageBps ? { maxSlippageBps: draft.maxSlippageBps } : {})
      };
      attached.oco = Boolean(risk.takeProfitPrice && (risk.stopLossPrice || risk.trailingDistance || risk.trailingBps));
      order.attachedRisk = attached;
    }
    return this.scope({ order });
  }

  private parseOrders(value: unknown): OrderSummary[] {
    return asArray(value).map((item) => this.parseOrder(asRecord(item)));
  }

  private async listOrders(path: typeof PATHS.openOrders | typeof PATHS.orderHistory, symbolId?: number): Promise<OrderSummary[]> {
    const orders: OrderSummary[] = [];
    let pageToken = "";
    for (let page = 0; page < 100; page += 1) {
      const raw = await this.transport.call<Record<string, unknown>>(path, this.scope({
        symbolId: symbolId ? [symbolId] : [], limit: 100, pageToken,
        includeAttachedRisk: true, includeAttachedRiskState: true
      }), { authenticated: true, retryRead: true });
      orders.push(...this.parseOrders(raw.orders));
      pageToken = asString(raw.nextPageToken);
      if (!pageToken) return orders;
    }
    throw new Error("Order pagination exceeded 100 pages");
  }

  private parseOrder(row: Record<string, unknown>): OrderSummary {
    const pair = this.catalogCache?.value.pairs.find((candidate) => candidate.symbolId === asNumber(row.symbolId));
    const scale = pair?.referencePriceScale ?? 9;
    const qtyScale = pair?.baseQuantityScale ?? 0;
    const result: OrderSummary = {
      orderId: encodeBase58Uint64(asString(row.orderId, "0")),
      symbolId: asNumber(row.symbolId),
      side: asString(row.side, "UNKNOWN"),
      status: asString(row.status, "UNKNOWN"),
      raw: row
    };
    const clientOrderId = asString(row.clientOrderId);
    if (clientOrderId) result.clientOrderId = clientOrderId;
    if (row.priceTicks !== undefined) result.price = scaledToDecimal(asString(row.priceTicks), scale);
    const totalQtyScaled = firstDefined(row.origQtyScaled, row.totalQtyScaled, row.qtyScaled);
    if (totalQtyScaled !== undefined) {
      result.totalQty = scaledToDecimal(asString(totalQtyScaled), qtyScale);
      result.qty = result.totalQty;
    }
    if (row.cumQtyScaled !== undefined) result.cumulativeQty = scaledToDecimal(asString(row.cumQtyScaled), qtyScale);
    if (row.leavesQtyScaled !== undefined) result.leavesQty = scaledToDecimal(asString(row.leavesQtyScaled), qtyScale);
    const averagePriceTicks = firstDefined(row.avgPriceTicks, row.avgFillPriceTicks, row.averagePriceTicks);
    if (averagePriceTicks !== undefined) result.averagePrice = scaledToDecimal(asString(averagePriceTicks), scale);
    const orderType = asString(row.orderType) || asString(row.type);
    const timeInForce = asString(row.timeInForce);
    if (orderType) result.orderType = orderType;
    if (timeInForce) result.timeInForce = timeInForce;
    const createdAt = asString(row.createdAt) || asString(row.createdTsNs) || asString(row.createdAtTsNs);
    if (createdAt) result.createdAt = createdAt;
    const updatedAt = asString(row.updatedAt) || asString(row.updatedTsNs) || asString(row.updatedAtTsNs);
    if (updatedAt) result.updatedAt = updatedAt;
    return result;
  }

  private parseOrderExecution(row: Record<string, unknown>, pair: PairConfig): OrderExecution {
    const feeAsset = asString(row.feeAsset);
    const result: OrderExecution = {
      price: scaledToDecimal(asString(row.priceTicks, "0"), pair.referencePriceScale),
      qty: scaledToDecimal(asString(row.qtyScaled, "0"), pair.baseQuantityScale)
    };
    const liquidity = asString(row.liquidity) || asString(row.liquidityRole);
    const matchId = asString(row.matchId);
    const tsNs = asString(row.tsNs);
    if (liquidity) result.liquidity = liquidity;
    if (feeAsset) result.feeAsset = feeAsset;
    if (matchId) result.matchId = matchId;
    if (tsNs) result.tsNs = tsNs;
    if (row.feeAmountE18 !== undefined) result.fee = scaledToDecimal(readU128(row.feeAmountE18), 18);
    else if (row.feeScaled !== undefined) {
      const feeScale = feeAsset.includes("BASE") ? pair.baseQuantityScale : pair.quoteQuantityScale;
      result.fee = scaledToDecimal(asString(row.feeScaled), feeScale);
    }
    return result;
  }

  private parsePair(row: Record<string, unknown>): PairConfig {
    return {
      symbolId: asNumber(row.symbolId), symbol: asString(row.symbol), baseAsset: asString(row.baseAsset), quoteAsset: asString(row.quoteAsset),
      tickSize: asString(row.tickSize), stepSize: asString(row.stepSize), minNotionalQuote: asString(row.minNotionalQuote),
      minQtyBase: asString(row.minQtyBase), baseQuantityScale: asNumber(row.baseQuantityScale), quoteQuantityScale: asNumber(row.quoteQuantityScale),
      referencePriceScale: asNumber(row.referencePriceScale, 9), status: asString(row.status),
      defaultMarketSlippageBpsBuy: asNumber(row.defaultMarketSlippageBpsBuy),
      defaultMarketSlippageBpsSell: asNumber(row.defaultMarketSlippageBpsSell), maxClientRefDriftBps: asNumber(row.maxClientRefDriftBps)
    };
  }

  private scope(body: Record<string, unknown>): Record<string, unknown> {
    return this.config.subaccountId ? { ...body, subaccountId: this.config.subaccountId } : body;
  }
}

function requirePair(catalog: SpotCatalog, symbolId: number): PairConfig {
  const pair = catalog.pairs.find((candidate) => candidate.symbolId === symbolId);
  if (!pair) throw new Error(`Unknown Polyester symbol ID: ${symbolId}`);
  return pair;
}

function nearestDepth(value: number): number {
  const supported = Object.keys(DEPTHS).map(Number);
  return supported.reduce((best, current) => Math.abs(current - value) < Math.abs(best - value) ? current : best, 20);
}

function optionalScaled(value: unknown, scale: number): string | null {
  return value === undefined || value === null || value === "" ? null : scaledToDecimal(asString(value), scale);
}

function readU128(value: unknown): string {
  if (typeof value === "string") return value;
  const row = asRecord(value);
  if (typeof row.value === "string") return row.value;
  if (row.hi !== undefined || row.lo !== undefined) {
    return ((BigInt(asString(row.hi, "0")) << 64n) + BigInt(asString(row.lo, "0"))).toString();
  }
  return "0";
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function detectTriggerType(row: Record<string, unknown>): string {
  for (const [field, label] of [["stopLoss", "STOP_LOSS"], ["takeProfit", "TAKE_PROFIT"], ["trailingStop", "TRAILING_STOP"], ["twap", "TWAP"], ["ladder", "LADDER"]] as const) {
    if (row[field] !== undefined) return label;
  }
  return asString(row.triggerType, "UNKNOWN");
}

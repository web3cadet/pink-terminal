export type TradingMode = "paper" | "read_only" | "live";
export type OrderSide = "BUY" | "SELL";
export type OrderKind = "MARKET_IOC" | "LIMIT_GTC" | "LIMIT_GTD" | "LIMIT_IOC" | "LIMIT_FOK";
export type TriggerKind = "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "TWAP" | "LADDER";

export interface AssetConfig {
  asset: string;
  ledgerId: number;
  name: string;
  quantityDisplayDecimals: number;
  quantityScale: number;
}

export interface PairConfig {
  symbolId: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minNotionalQuote: string;
  minQtyBase: string;
  baseQuantityScale: number;
  quoteQuantityScale: number;
  referencePriceScale: number;
  status: string;
  defaultMarketSlippageBpsBuy: number;
  defaultMarketSlippageBpsSell: number;
  maxClientRefDriftBps: number;
}

export interface SpotCatalog {
  assets: AssetConfig[];
  pairs: PairConfig[];
  tsSec: string;
}

export interface MarketOverview {
  symbolId: number;
  lastPrice: string | null;
  change24hBps: number | null;
  high24h: string | null;
  low24h: string | null;
  volume24hBase: string | null;
  volume24hQuote: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  indexPrice: string | null;
}

export interface OrderbookLevel {
  price: string;
  qty: string;
}

export interface Orderbook {
  symbolId: number;
  bookSeq: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  ts: string;
}

export interface Candle {
  tsSec: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
}

export interface Balance {
  assetId: number;
  trading: string;
  funding: string;
  reserved: string;
  available: string;
}

export interface AttachedRiskDraft {
  takeProfitPrice?: string;
  stopLossPrice?: string;
  trailingDistance?: string;
  trailingBps?: number;
  activationPrice?: string;
}

export interface OrderDraft {
  symbolId: number;
  symbol: string;
  side: OrderSide;
  kind: OrderKind;
  qty?: string;
  maxQuoteDebit?: string;
  price?: string;
  expireAt?: string;
  postOnly?: boolean;
  maxSlippageBps?: number;
  clientRefPrice?: string;
  feeAsset?: "BASE" | "QUOTE";
  attachedRisk?: AttachedRiskDraft;
}

export interface OrderPreview {
  admissible: boolean;
  rejectionCode?: string;
  rejectionMessage?: string;
  resolvedBaseQty?: string;
  protectedPriceBound?: string;
  raw: Record<string, unknown>;
}

export interface OrderReceipt {
  orderId?: string;
  clientOrderId: string;
  acceptedAt?: string;
  status: "paper" | "accepted" | "unknown";
  raw: Record<string, unknown>;
}

export interface OrderSummary {
  orderId: string;
  clientOrderId?: string;
  symbolId: number;
  side: string;
  status: string;
  price?: string;
  qty?: string;
  totalQty?: string;
  cumulativeQty?: string;
  leavesQty?: string;
  averagePrice?: string;
  orderType?: string;
  timeInForce?: string;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface OrderDetails {
  order: OrderSummary;
  executions: OrderExecution[];
  executionCount: number;
  transferCount: number;
  nextPageToken?: string;
  raw: Record<string, unknown>;
}

export interface OrderExecution {
  price: string;
  qty: string;
  liquidity?: string;
  fee?: string;
  feeAsset?: string;
  matchId?: string;
  tsNs?: string;
}

export interface TriggerDraft {
  symbolId: number;
  symbol: string;
  kind: TriggerKind;
  side: OrderSide;
  qty: string;
  triggerPrice?: string;
  trailingDistance?: string;
  trailingBps?: number;
  activationPrice?: string;
  durationMs?: number;
  sliceIntervalMs?: number;
  priceMin?: string;
  priceMax?: string;
  levels?: number;
  childKind: "MARKET_IOC" | "LIMIT_GTC";
  childLimitPrice?: string;
  postOnly?: boolean;
  maxSlippageBps?: number;
}

export interface TriggerSummary {
  triggerId: string;
  clientTriggerId?: string;
  symbolId: number;
  type: string;
  status: string;
  side?: string;
  raw: Record<string, unknown>;
}

export interface ExchangeGateway {
  getAccountStats?(): Promise<{ volume30dUsd?: string; asOf?: string }>;
  getCatalog(force?: boolean): Promise<SpotCatalog>;
  listMarketOverview(): Promise<MarketOverview[]>;
  getOrderbook(symbolId: number, depth?: number): Promise<Orderbook>;
  getCandles(symbolId: number, timeframe: string, limit?: number): Promise<Candle[]>;
  listBalances(): Promise<Balance[]>;
  previewOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderPreview>;
  createOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderReceipt>;
  listOpenOrders(symbolId?: number): Promise<OrderSummary[]>;
  listOrderHistory(symbolId?: number): Promise<OrderSummary[]>;
  getOrderByClientId(clientOrderId: string): Promise<OrderSummary | null>;
  getOrderDetails(orderId: string, pageToken?: string): Promise<OrderDetails | null>;
  cancelOrder(clientOrderId: string, symbolId: number): Promise<Record<string, unknown>>;
  cancelAll(symbolIds: number[], dryRun: boolean, requestId: string): Promise<Record<string, unknown>>;
  listTriggers(symbolId?: number): Promise<TriggerSummary[]>;
  createTrigger(draft: TriggerDraft, clientTriggerId: string): Promise<Record<string, unknown>>;
  cancelTrigger(triggerId: string, symbolId: number): Promise<Record<string, unknown>>;
  pauseTrigger(triggerId: string, symbolId: number): Promise<Record<string, unknown>>;
  resumeTrigger(triggerId: string, symbolId: number): Promise<Record<string, unknown>>;
}

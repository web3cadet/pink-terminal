import { loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { PolyesterGateway } from "./polyester/gateway.js";
import { PaperGateway } from "./polyester/paper-gateway.js";
import { ReadOnlyGateway } from "./polyester/read-only-gateway.js";
import { AppDatabase } from "./storage/database.js";
import { TradingService } from "./services/trading.js";
import { createTelegramBot } from "./bot/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const database = new AppDatabase(config.databasePath);
  const liveGateway = new PolyesterGateway(config, logger);
  const gateway = config.tradingMode === "paper"
    ? new PaperGateway(liveGateway)
    : config.tradingMode === "read_only"
      ? new ReadOnlyGateway(liveGateway)
      : liveGateway;
  const trading = new TradingService(config, gateway, database, logger);
  const bot = createTelegramBot({ config, gateway, database, trading, logger });

  try {
    await bot.api.setMyCommands([
      { command: "menu", description: "Open Pink Terminal" },
      { command: "cancel", description: "Cancel the current wizard" }
    ]);

    let maintenanceBusy = false;
    const runMaintenance = async (): Promise<void> => {
      if (maintenanceBusy) return;
      maintenanceBusy = true;
      try {
        const resolved = await trading.reconcileUnknownOrders();
        if (resolved > 0) logger.info("orders_reconciled", { resolved });
        const addedFills = await trading.syncBotTradingVolume();
        if (addedFills > 0) logger.info("bot_volume_updated", { addedFills });
      } catch (error) {
        logger.warn("maintenance_loop_failed", { error: error instanceof Error ? error.message : "unknown" });
      } finally {
        maintenanceBusy = false;
      }
    };
    void runMaintenance();
    const reconcileTimer = setInterval(() => void runMaintenance(), config.pollIntervalMs);
    reconcileTimer.unref();

    let stopping = false;
    async function shutdown(signal: string): Promise<void> {
      if (stopping) return;
      stopping = true;
      logger.info("shutdown_started", { signal });
      clearInterval(reconcileTimer);
      await bot.stop();
      database.close();
    }

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    logger.info("bot_starting", {
      mode: config.tradingMode,
      apiUrl: config.apiUrl,
      authenticated: Boolean(config.apiKeyId && config.apiSecretHex),
      allowedChats: config.allowedChatIds.size,
      allowedUsers: config.allowedUserIds.size
    });

    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => logger.info("bot_started", { mode: config.tradingMode })
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

try {
  await main();
} catch (error) {
  new Logger("error").error("startup_failed", { error: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
}

import { telegramBotLink } from "../setup/telegram-identity.js";

try {
  console.log(await telegramBotLink(process.env.TELEGRAM_BOT_TOKEN ?? ""));
} catch {
  // Fetch errors can include the credential-bearing URL. Do not print them.
  console.error("Telegram bot link unavailable.");
  process.exitCode = 1;
}

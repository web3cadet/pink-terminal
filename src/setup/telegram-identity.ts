/** Public bot URL only. Never expose the credential or raw Telegram response. */
export async function telegramBotLink(token: string, request: typeof fetch = fetch): Promise<string> {
  if (!/^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(token)) throw new Error("Telegram identity unavailable");
  const response = await request(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error("Telegram identity unavailable");
  const data = await response.json() as { ok?: boolean; result?: { is_bot?: boolean; username?: string } };
  const username = data?.result?.username;
  if (data?.ok !== true || data.result?.is_bot !== true || typeof username !== "string"
      || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("Telegram identity unavailable");
  return `https://t.me/${username}`;
}

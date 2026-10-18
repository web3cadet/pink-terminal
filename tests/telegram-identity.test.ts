import { describe, expect, it, vi } from "vitest";
import { telegramBotLink } from "../src/setup/telegram-identity.js";

const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345";
function request(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}
describe("installer Telegram link", () => {
  it("returns only the verified bot URL and sets a request timeout", async () => {
    const fetcher = request({ ok: true, result: { is_bot: true, username: "Pink_Test_Bot" } });
    expect(await telegramBotLink(token, fetcher)).toBe("https://t.me/Pink_Test_Bot");
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects missing credentials without a request", async () => {
    const fetcher = request({});
    await expect(telegramBotLink("", fetcher)).rejects.toThrow("Telegram identity unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ok: false }, null,
    { ok: true, result: { is_bot: false, username: "Pink_Test_Bot" } },
    { ok: true, result: { is_bot: true, username: "bad/name" } },
    { ok: true, result: { is_bot: true, username: "bad\nname" } },
    { ok: true, result: { is_bot: true } }
  ])("rejects malformed or non-bot identities: %j", async body => {
    await expect(telegramBotLink(token, request(body))).rejects.toThrow("Telegram identity unavailable");
  });
  it("rejects HTTP failure", async () => {
    await expect(telegramBotLink(token, request({}, 401))).rejects.toThrow("Telegram identity unavailable");
  });
});

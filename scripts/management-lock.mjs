import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";

const ENV_KEY = "PINK_MANAGEMENT_OWNER";

export function runtimeEnvironment() {
  const env = { ...process.env };
  delete env[ENV_KEY];
  return env;
}

// The OS releases the listening endpoint after a crash: no stale lock file to delete.
// This is operation coordination, not an authorization boundary.
export async function withManagementLock(directory, action) {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw new Error("Unsupported management platform.");
  const canonical = realpathSync(directory);
  const root = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  let inherited;
  try { inherited = JSON.parse(process.env[ENV_KEY] || "null"); } catch {}
  if (inherited?.root === root && Number.isSafeInteger(inherited.pid) && inherited.pid > 0) {
    let alive = false;
    try { process.kill(inherited.pid, 0); alive = true; } catch {}
    if (alive && inherited.pid !== process.pid) return action();
    if (alive) throw new Error("Another management operation is running in this process.");
  }
  const hash = createHash("sha256").update(root).digest("hex");
  // macOS has no Windows named pipes. A loopback listener avoids stale Unix socket
  // files and unsafe stale-file deletion races. A port collision fails closed.
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\pink-management-${hash}`
    : { host: "127.0.0.1", port: 16384 + (parseInt(hash.slice(0, 8), 16) % 49152), exclusive: true };
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(new Error(
      error.code === "EADDRINUSE" ? "Another management or installation operation is running, or its local lock endpoint is occupied. Wait for it to finish and retry." : "Cannot acquire the installation management lock.",
      { cause: error }
    )));
    server.listen(endpoint, resolve);
  });
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = JSON.stringify({ root, pid: process.pid });
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous;
    await new Promise(resolve => server.close(resolve));
  }
}

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";

const ENV_KEY = "PINK_MANAGEMENT_OWNER";

export function runtimeEnvironment() {
  const env = { ...process.env };
  delete env[ENV_KEY];
  return env;
}

// Windows releases a named pipe even after a crash: no stale lock file to delete.
// This is operation coordination, not an authorization boundary.
export async function withManagementLock(directory, action) {
  if (process.platform !== "win32") return action();
  const root = realpathSync(directory).toLowerCase();
  let inherited;
  try { inherited = JSON.parse(process.env[ENV_KEY] || "null"); } catch {}
  if (inherited?.root === root && Number.isSafeInteger(inherited.pid) && inherited.pid > 0) {
    let alive = false;
    try { process.kill(inherited.pid, 0); alive = true; } catch {}
    if (alive) return action();
  }
  const pipe = `\\\\.\\pipe\\pink-management-${createHash("sha256").update(root).digest("hex")}`;
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(new Error(
      error.code === "EADDRINUSE" ? "Another management or installation operation is running in this folder. Wait for it to finish and retry." : "Cannot acquire the installation management lock.",
      { cause: error }
    )));
    server.listen(pipe, resolve);
  });
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = JSON.stringify({ root, pid: process.pid });
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous;
    await new Promise(resolve => server.close(resolve));
  }
}

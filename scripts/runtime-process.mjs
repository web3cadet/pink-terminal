// A control socket or state file disappearing is not proof of process exit.
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; } // Permission errors must fail closed.
}

export function trackChild(child) {
  const tracked = { child, closed: false, error: undefined };
  child.once("error", error => { tracked.error = error; });
  child.once("close", () => { tracked.closed = true; });
  return tracked;
}

export async function waitForProcessExit(pid, { timeoutMs = 11000, tracked } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!isProcessAlive(pid) && (!tracked || tracked.closed)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return !isProcessAlive(pid) && (!tracked || tracked.closed);
}

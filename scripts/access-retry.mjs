// Each check runs in a fresh process so edits to .env take effect on Enter.
export async function retryAccessCheck({ check, ask, replaceKey, print }) {
  while (!(await check())) {
    print("\n1) Recheck — press Enter");
    print("2) Enter a new API Key ID and private seed");
    while (true) {
      const choice = (await ask("Selection")).trim();
      if (choice === "" || choice === "1") break;
      if (choice === "2") { await replaceKey(); break; }
      print("Press Enter to recheck, or type 2 to replace the API key.");
    }
  }
}

export function replaceApiValues(text, keyId, seed) {
  if (!/^ak_[A-Za-z0-9]{16,}$/.test(keyId) || !/^[a-fA-F0-9]{64}$/.test(seed)) {
    throw new Error("Invalid API key format");
  }
  let result = text;
  for (const [name, value] of [["POLYESTER_API_KEY_ID", keyId], ["POLYESTER_API_SECRET_HEX", seed]]) {
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "gm");
    result = pattern.test(result) ? result.replace(pattern, `${name}=${value}`) : `${result.trimEnd()}\n${name}=${value}\n`;
  }
  return result;
}

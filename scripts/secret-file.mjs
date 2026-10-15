import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";

export async function protectSecretFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Secret configuration must be an ordinary, unlinked file.");
  if (process.platform !== "win32") { await chmod(file, 0o600); return; }
  // Use SIDs, not localized account/group names. Do not change directory permissions.
  const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.File]::SetAccessControl($env:PINK_SECRET_FILE, $acl)
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PINK_SECRET_FILE: file }
  });
  if (result.status !== 0) throw new Error("Could not restrict .env access to your Windows account. Configuration was not saved; check file ownership and permissions.");
}

export async function writeSecretFile(file, content) {
  const temporary = `${file}.tmp.${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.close(); handle = undefined;
    // Apply Windows ACL before any credentials are written.
    await protectSecretFile(temporary);
    handle = await open(temporary, "w");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    // Never unlink the old configuration first: failed replacement preserves it.
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

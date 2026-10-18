#!/usr/bin/env node
import { localPlatform } from "./local-platform.mjs";
try {
  await import(`./${localPlatform().manager}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

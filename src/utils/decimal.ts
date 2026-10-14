const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function decimalToScaled(value: string, scale: number): string {
  const trimmed = value.trim();
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) throw new Error(`Invalid non-negative decimal: ${value}`);
  const integer = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > scale) throw new Error(`Too many decimals: maximum is ${scale}`);
  return (BigInt(integer) * 10n ** BigInt(scale) + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0")).toString();
}

export function scaledToDecimal(value: string | number | bigint, scale: number): string {
  const raw = BigInt(value);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(scale);
  const integer = abs / base;
  const fraction = (abs % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function compareDecimals(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const scale = Math.max(leftParts[1]?.length ?? 0, rightParts[1]?.length ?? 0);
  const a = BigInt(decimalToScaled(left, scale));
  const b = BigInt(decimalToScaled(right, scale));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function multiplyDecimals(left: string, right: string, outputScale = 18): string {
  const leftScale = left.split(".")[1]?.length ?? 0;
  const rightScale = right.split(".")[1]?.length ?? 0;
  const raw = BigInt(decimalToScaled(left, leftScale)) * BigInt(decimalToScaled(right, rightScale));
  const inputScale = leftScale + rightScale;
  const adjusted = inputScale > outputScale
    ? raw / 10n ** BigInt(inputScale - outputScale)
    : raw * 10n ** BigInt(outputScale - inputScale);
  return scaledToDecimal(adjusted, outputScale);
}

export function isStepAligned(value: string, step: string): boolean {
  const valueScale = value.split(".")[1]?.length ?? 0;
  const stepScale = step.split(".")[1]?.length ?? 0;
  const scale = Math.max(valueScale, stepScale);
  const a = BigInt(decimalToScaled(value, scale));
  const b = BigInt(decimalToScaled(step, scale));
  return b > 0n && a % b === 0n;
}

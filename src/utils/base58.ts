const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

export function encodeBase58Uint64(value: string | bigint): string {
  let current = BigInt(value);
  if (current < 0n || current > 18_446_744_073_709_551_615n) throw new Error("ID is outside uint64 range");
  if (current === 0n) return "1";
  let output = "";
  while (current > 0n) {
    const remainder = Number(current % BASE);
    output = ALPHABET[remainder] + output;
    current /= BASE;
  }
  return output;
}

export function decodeBase58Uint64(value: string): string {
  if (!value) throw new Error("ID is empty");
  let output = 0n;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base58 ID");
    output = output * BASE + BigInt(index);
  }
  if (output > 18_446_744_073_709_551_615n) throw new Error("ID is outside uint64 range");
  return output.toString();
}

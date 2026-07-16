import { readFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";

export async function keypairFromEnvironment(name: string): Promise<Keypair> {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required as a keypair JSON path, JSON byte array, or base64 secret`,
    );
  const encoded = value.trim().startsWith("[")
    ? value
    : value.startsWith("/") || value.startsWith(".") || value.endsWith(".json")
      ? await readFile(value, "utf8")
      : value;
  let bytes: Uint8Array;
  try {
    bytes = encoded.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(encoded) as number[])
      : new Uint8Array(Buffer.from(encoded, "base64"));
  } catch {
    throw new Error(`${name} could not be decoded`);
  }
  if (bytes.length !== 64)
    throw new Error(`${name} must contain 64 secret bytes`);
  return Keypair.fromSecretKey(bytes);
}

export function publicKeyFromEnvironment(name: string): PublicKey {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new PublicKey(value);
}

export function devnetConnection() {
  const endpoint =
    process.env.SOLANA_HTTP_RPC_URL ?? "https://api.devnet.solana.com";
  if (/mainnet/i.test(endpoint))
    throw new Error("GoalDrop ops scripts refuse Mainnet endpoints");
  return endpoint;
}

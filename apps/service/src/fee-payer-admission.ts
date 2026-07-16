import { Connection } from "@solana/web3.js";
import type { ServiceConfig } from "./config.js";
import { keypairFromConfig } from "./workers/solana.js";

interface BalanceSample {
  checkedAt: number;
  lamports: number;
}

const samples = new Map<string, BalanceSample>();
const pending = new Map<string, Promise<number>>();

export async function ensureFeePayerCapacity(
  config: ServiceConfig,
): Promise<number> {
  const lamports = await readFeePayerBalance(config);
  if (lamports < config.FEE_PAYER_MIN_LAMPORTS) {
    throw new Error("sponsored transaction capacity is unavailable");
  }
  return lamports;
}

export async function readFeePayerBalance(
  config: ServiceConfig,
): Promise<number> {
  if (config.NODE_ENV === "test") return Number.MAX_SAFE_INTEGER;
  const feePayer = keypairFromConfig(
    config.FEE_PAYER_KEYPAIR,
    "FEE_PAYER_KEYPAIR",
  );
  const key = `${config.SOLANA_HTTP_RPC_URL}:${feePayer.publicKey.toBase58()}`;
  const cached = samples.get(key);
  let lamports: number;
  if (cached && Date.now() - cached.checkedAt < 5_000) {
    lamports = cached.lamports;
  } else {
    let request = pending.get(key);
    if (!request) {
      const connection = new Connection(
        config.SOLANA_HTTP_RPC_URL,
        "confirmed",
      );
      request = connection.getBalance(feePayer.publicKey, "confirmed");
      pending.set(key, request);
    }
    try {
      lamports = await request;
      samples.set(key, { checkedAt: Date.now(), lamports });
    } catch {
      throw new Error("fee payer balance RPC is unavailable");
    } finally {
      pending.delete(key);
    }
  }
  return lamports;
}

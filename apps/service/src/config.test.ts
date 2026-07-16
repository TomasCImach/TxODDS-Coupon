import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const relayerSecret = Buffer.from(Keypair.generate().secretKey).toString(
  "base64",
);

function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgres://goaldrop:goaldrop@localhost:5432/goaldrop",
    SOLANA_CLUSTER: "devnet",
    SOLANA_HTTP_RPC_URL: "https://api.devnet.solana.com",
    SOLANA_WS_RPC_URL: "wss://api.devnet.solana.com",
    GOALDROP_PROGRAM_ID: Keypair.generate().publicKey.toBase58(),
    GOALDROP_REWARD_MINT: Keypair.generate().publicKey.toBase58(),
    TXLINE_API_ORIGIN: "https://txline-dev.txodds.com",
    TXLINE_PROGRAM_ID: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
    TXLINE_TXL_MINT: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
    RELAYER_KEYPAIR: relayerSecret,
    RECEIPT_CAPABILITY_KEY: Buffer.from(Keypair.generate().secretKey).toString(
      "base64",
    ),
    FEE_PAYER_KEYPAIR: Buffer.from(Keypair.generate().secretKey).toString(
      "base64",
    ),
  };
}

describe("service role configuration", () => {
  it("uses RELAYER_KEYPAIR as the API receipt-signing key", () => {
    const config = loadConfig("api", apiEnvironment());
    expect(config.RELAYER_KEYPAIR).toBe(relayerSecret);
  });

  it("does not accept the removed duplicate receipt-key variable", () => {
    const environment = apiEnvironment();
    delete environment.RELAYER_KEYPAIR;
    environment.RELAYER_RECEIPT_SECRET_KEY = relayerSecret;
    expect(() => loadConfig("api", environment)).toThrow(
      "RELAYER_KEYPAIR is required for api",
    );
  });
});

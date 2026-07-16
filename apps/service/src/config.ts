import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

export const serviceRoles = [
  "api",
  "txline-listener",
  "oracle-worker",
  "settlement-worker",
  "chain-indexer",
  "demo-controller",
] as const;
export type ServiceRole = (typeof serviceRoles)[number];

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const publicKeyString = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, "must be a Solana public key");

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  PUBLIC_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  SOLANA_CLUSTER: z.literal("devnet"),
  SOLANA_HTTP_RPC_URL: z.string().url(),
  SOLANA_WS_RPC_URL: z.string().url(),
  GOALDROP_PROGRAM_ID: publicKeyString,
  GOALDROP_REWARD_MINT: publicKeyString,
  TXLINE_API_ORIGIN: z.literal("https://txline-dev.txodds.com"),
  TXLINE_PROGRAM_ID: z.literal("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  TXLINE_TXL_MINT: z.literal("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
  TXLINE_SERVICE_LEVEL: z.coerce.number().int().min(1).default(1),
  ROUND_DURATION_SECONDS: z.coerce
    .number()
    .int()
    .default(120)
    .refine((value) => value === 120),
  LIVE_EVENT_MAX_LATENESS_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(300)
    .default(60),
  DEFAULT_HARD_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(86_400)
    .default(28_800),
  TXLINE_LISTENER_ENABLED: booleanString.default(true),
  TXLINE_PUBLIC_OUTPUT_ENABLED: booleanString.default(false),
  TXLINE_RAW_RETENTION_ENABLED: booleanString.default(false),
  DEMO_MODE_ENABLED: booleanString.default(true),
  DEMO_FAUCET_ENABLED: booleanString.default(true),
  DEMO_FAUCET_AMOUNT_BASE_UNITS: z.coerce
    .bigint()
    .min(1n)
    .max(1_000_000_000_000n)
    .default(500_000_000n),
  RECEIPT_CAPABILITY_KEY: z.string().min(32).optional(),
  TXLINE_GUEST_JWT: z.string().optional(),
  TXLINE_API_TOKEN: z.string().optional(),
  TXLINE_RAW_ENCRYPTION_KEY: z.string().optional(),
  ORACLE_KEYPAIR: z.string().optional(),
  RELAYER_KEYPAIR: z.string().optional(),
  DEMO_AUTHORITY_KEYPAIR: z.string().optional(),
  FEE_PAYER_KEYPAIR: z.string().optional(),
  FEE_PAYER_MIN_LAMPORTS: z.coerce
    .number()
    .int()
    .min(100_000)
    .default(10_000_000_000),
  DEMO_CAMPAIGN: publicKeyString.optional(),
});

export type ServiceConfig = ReturnType<typeof loadConfig>;

export function loadConfig(
  role: ServiceRole,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = schema.parse(env);
  const required: Partial<
    Record<ServiceRole, readonly (keyof typeof config)[]>
  > = {
    api: ["RELAYER_KEYPAIR", "RECEIPT_CAPABILITY_KEY", "FEE_PAYER_KEYPAIR"],
    "oracle-worker": ["ORACLE_KEYPAIR", "FEE_PAYER_KEYPAIR"],
    "settlement-worker": ["RELAYER_KEYPAIR", "FEE_PAYER_KEYPAIR"],
    "demo-controller": [
      "DEMO_AUTHORITY_KEYPAIR",
      "FEE_PAYER_KEYPAIR",
      "DEMO_CAMPAIGN",
    ],
  };
  if (role === "txline-listener" && config.TXLINE_LISTENER_ENABLED) {
    required[role] = ["TXLINE_GUEST_JWT", "TXLINE_API_TOKEN"];
  }
  for (const key of required[role] ?? []) {
    if (!config[key]) throw new Error(`${String(key)} is required for ${role}`);
  }
  if (
    config.TXLINE_RAW_RETENTION_ENABLED &&
    !config.TXLINE_RAW_ENCRYPTION_KEY
  ) {
    throw new Error(
      "TXLINE_RAW_ENCRYPTION_KEY is required when raw retention is enabled",
    );
  }
  return { ...config, role };
}

export function decodeSecretBytes(
  value: string,
  expectedLength: number,
  name: string,
): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = value.trim().startsWith("[")
      ? Buffer.from(
          z.array(z.number().int().min(0).max(255)).parse(JSON.parse(value)),
        )
      : Buffer.from(value, "base64");
  } catch {
    throw new Error(`${name} must be a base64 or JSON byte array`);
  }
  if (bytes.length !== expectedLength)
    throw new Error(`${name} must contain ${expectedLength} bytes`);
  return new Uint8Array(bytes);
}

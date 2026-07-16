import { createPool, migrate } from "@goaldrop/db";
import { createApp } from "./app.js";
import { loadConfig, serviceRoles, type ServiceRole } from "./config.js";
import { validateOnchainConfig } from "./onchain-config.js";
import { runDemoController } from "./workers/demo.js";
import { runChainIndexer } from "./workers/indexer.js";
import { runOracleWorker } from "./workers/oracle.js";
import { keypairFromConfig } from "./workers/solana.js";
import { runSettlementWorker } from "./workers/settlement.js";
import { runTxlineSupervisor } from "./workers/txline.js";

const roleInput = process.argv[2] ?? "api";
if (!serviceRoles.includes(roleInput as ServiceRole)) {
  process.stderr.write(
    `Unknown service role ${roleInput}. Expected one of: ${serviceRoles.join(", ")}\n`,
  );
  process.exitCode = 1;
} else {
  await main(roleInput as ServiceRole).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "service failed"}\n`,
    );
    process.exitCode = 1;
  });
}

async function main(role: ServiceRole): Promise<void> {
  const config = loadConfig(role);
  process.env.SERVICE_ROLE = role;
  const pool = createPool(config.DATABASE_URL);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const logger = structuredLogger(role);
  try {
    await migrate(pool);
    const onchain = await validateOnchainConfig(config);
    if (role === "api") {
      const app = await createApp({ config, pool, onchain });
      abort.signal.addEventListener(
        "abort",
        () => {
          void app.close();
        },
        { once: true },
      );
      await app.listen({ host: config.HOST, port: config.PORT });
      logger.info({ host: config.HOST, port: config.PORT }, "API ready");
      await untilAborted(abort.signal);
      return;
    }
    if (role === "txline-listener") {
      logger.info(
        { role, listenerEnabled: config.TXLINE_LISTENER_ENABLED },
        "worker ready",
      );
      await runTxlineSupervisor(config, pool, logger, abort.signal);
    }
    if (role === "oracle-worker") {
      const authority = keypairFromConfig(
        config.ORACLE_KEYPAIR,
        "ORACLE_KEYPAIR",
      );
      if (!authority.publicKey.equals(onchain.oracle))
        throw new Error("ORACLE_KEYPAIR does not match PlatformConfig.oracle");
      logger.info(
        { role, authority: authority.publicKey.toBase58() },
        "worker ready",
      );
      await runOracleWorker(config, pool, logger, abort.signal);
    }
    if (role === "settlement-worker") {
      const authority = keypairFromConfig(
        config.RELAYER_KEYPAIR,
        "RELAYER_KEYPAIR",
      );
      if (!authority.publicKey.equals(onchain.relayer))
        throw new Error(
          "RELAYER_KEYPAIR does not match PlatformConfig.relayer",
        );
      logger.info(
        { role, authority: authority.publicKey.toBase58() },
        "worker ready",
      );
      await runSettlementWorker(config, pool, logger, abort.signal);
    }
    if (role === "chain-indexer") {
      logger.info(
        { role, program: config.GOALDROP_PROGRAM_ID },
        "worker ready",
      );
      await runChainIndexer(config, pool, logger, abort.signal);
    }
    if (role === "demo-controller") {
      const authority = keypairFromConfig(
        config.DEMO_AUTHORITY_KEYPAIR,
        "DEMO_AUTHORITY_KEYPAIR",
      );
      if (!authority.publicKey.equals(onchain.demoAuthority))
        throw new Error(
          "DEMO_AUTHORITY_KEYPAIR does not match PlatformConfig.demo_authority",
        );
      logger.info(
        { role, authority: authority.publicKey.toBase58() },
        "worker ready",
      );
      await runDemoController(config, pool, logger, abort.signal);
    }
  } finally {
    await pool.end();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function structuredLogger(role: string) {
  const log = (level: string, object: unknown, message?: string) => {
    process.stdout.write(
      `${JSON.stringify({ level, role, time: new Date().toISOString(), message, ...(isRecord(object) ? object : { detail: String(object) }) })}\n`,
    );
  };
  return {
    info: (object: unknown, message?: string) => log("info", object, message),
    warn: (object: unknown, message?: string) => log("warn", object, message),
    error: (object: unknown, message?: string) => log("error", object, message),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

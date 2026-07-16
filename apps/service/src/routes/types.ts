import type { DatabasePool } from "@goaldrop/db";
import type { ServiceConfig } from "../config.js";
import type { OnchainConfigSnapshot } from "../onchain-config.js";

export interface RouteDependencies {
  config: ServiceConfig;
  pool: DatabasePool;
  onchain: OnchainConfigSnapshot;
}

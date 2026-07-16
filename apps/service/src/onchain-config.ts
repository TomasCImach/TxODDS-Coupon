import { DEVNET_NETWORK_DOMAIN } from "@goaldrop/protocol";
import {
  configPda,
  decodePlatformConfigAccount,
} from "@goaldrop/solana-client";
import { Connection, PublicKey } from "@solana/web3.js";
import type { ServiceConfig } from "./config.js";

export interface OnchainConfigSnapshot {
  address: PublicKey;
  authorityEpoch: number;
  admin: PublicKey;
  oracle: PublicKey;
  relayer: PublicKey;
  demoAuthority: PublicKey;
  rewardMint: PublicKey;
  rewardDecimals: number;
}

export async function validateOnchainConfig(
  config: ServiceConfig,
): Promise<OnchainConfigSnapshot> {
  const programId = new PublicKey(config.GOALDROP_PROGRAM_ID);
  const [configAddress] = configPda(programId);
  const connection = new Connection(config.SOLANA_HTTP_RPC_URL, {
    commitment: "confirmed",
    wsEndpoint: config.SOLANA_WS_RPC_URL,
  });
  const account = await connection.getAccountInfo(configAddress, "confirmed");
  if (!account)
    throw new Error(
      `PlatformConfig ${configAddress.toBase58()} is absent on Devnet`,
    );
  if (!account.owner.equals(programId))
    throw new Error("PlatformConfig owner does not match GOALDROP_PROGRAM_ID");
  if (account.data.length !== 240)
    throw new Error(
      `PlatformConfig has unexpected size ${account.data.length}`,
    );
  const platform = decodePlatformConfigAccount(account.data);
  if (!platform.rewardMint.equals(new PublicKey(config.GOALDROP_REWARD_MINT)))
    throw new Error("configured reward mint disagrees with PlatformConfig");
  if (
    !Buffer.from(platform.networkDomain).equals(
      Buffer.from(DEVNET_NETWORK_DOMAIN),
    )
  )
    throw new Error("PlatformConfig is not domain-separated for Devnet");
  return {
    address: configAddress,
    authorityEpoch: platform.authorityEpoch,
    admin: platform.admin,
    oracle: platform.oracle,
    relayer: platform.relayer,
    demoAuthority: platform.demoAuthority,
    rewardMint: platform.rewardMint,
    rewardDecimals: platform.rewardDecimals,
  };
}

export type DeploymentTier = "devnet" | "production";

const appIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolvePasskeyDeploymentConfig(input: {
  deploymentTier?: string;
  appId?: string;
}): { deploymentTier: DeploymentTier; appId?: string } {
  const deploymentTier = input.deploymentTier ?? "devnet";
  if (deploymentTier !== "devnet" && deploymentTier !== "production")
    throw new Error("NEXT_PUBLIC_DEPLOYMENT_TIER must be devnet or production");

  const appId = input.appId?.trim() || undefined;
  if (deploymentTier === "production" && !appId)
    throw new Error(
      "NEXT_PUBLIC_PASSKEY_APP_ID is required for production deployments",
    );
  if (appId && !appIdPattern.test(appId))
    throw new Error("NEXT_PUBLIC_PASSKEY_APP_ID must be a valid UUID");

  return appId ? { deploymentTier, appId } : { deploymentTier };
}

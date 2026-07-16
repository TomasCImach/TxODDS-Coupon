import { describe, expect, it } from "vitest";
import { resolvePasskeyDeploymentConfig } from "./deployment-config";

describe("Passkeys deployment configuration", () => {
  it("allows Devnet without an App ID", () => {
    expect(resolvePasskeyDeploymentConfig({})).toEqual({
      deploymentTier: "devnet",
    });
  });

  it("requires a nonblank App ID for production", () => {
    expect(() =>
      resolvePasskeyDeploymentConfig({ deploymentTier: "production" }),
    ).toThrow("NEXT_PUBLIC_PASSKEY_APP_ID is required for production");
    expect(() =>
      resolvePasskeyDeploymentConfig({
        deploymentTier: "production",
        appId: "   ",
      }),
    ).toThrow("NEXT_PUBLIC_PASSKEY_APP_ID is required for production");
  });

  it("accepts an issued UUID and rejects malformed deployment values", () => {
    expect(
      resolvePasskeyDeploymentConfig({
        deploymentTier: "production",
        appId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      deploymentTier: "production",
      appId: "00000000-0000-4000-8000-000000000001",
    });
    expect(() =>
      resolvePasskeyDeploymentConfig({ deploymentTier: "preview" }),
    ).toThrow("NEXT_PUBLIC_DEPLOYMENT_TIER must be devnet or production");
    expect(() =>
      resolvePasskeyDeploymentConfig({ appId: "not-a-uuid" }),
    ).toThrow("NEXT_PUBLIC_PASSKEY_APP_ID must be a valid UUID");
  });
});

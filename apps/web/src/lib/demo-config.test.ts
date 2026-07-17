import { describe, expect, it } from "vitest";
import { resolveDemoCampaign } from "./demo-config";

describe("demo campaign configuration", () => {
  it("prefers the browser campaign and falls back to the local service campaign", () => {
    expect(resolveDemoCampaign("browser-campaign", "service-campaign")).toBe(
      "browser-campaign",
    );
    expect(resolveDemoCampaign(undefined, "service-campaign")).toBe(
      "service-campaign",
    );
    expect(resolveDemoCampaign(" ", "service-campaign")).toBe(
      "service-campaign",
    );
  });

  it("returns null when neither campaign is configured", () => {
    expect(resolveDemoCampaign(undefined, undefined)).toBeNull();
  });
});

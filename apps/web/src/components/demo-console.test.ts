import { describe, expect, it } from "vitest";
import { busyLabel, shouldClearDemoSession } from "./demo-console";

describe("demo console busy labels", () => {
  it("describes the action actually in flight", () => {
    expect(busyLabel("start")).toBe("Starting fresh controller…");
    expect(busyLabel("goal")).toBe("Submitting synthetic goal…");
    expect(busyLabel("complete")).toBe("Completing demo match…");
  });
});

describe("demo console session recovery", () => {
  it("clears stale controllers when the API says they cannot continue", () => {
    expect(shouldClearDemoSession("Demo capability expired")).toBe(true);
    expect(shouldClearDemoSession("No reward round remaining")).toBe(true);
  });

  it("preserves the controller for retryable failures", () => {
    expect(shouldClearDemoSession("Demo service unavailable")).toBe(false);
  });
});

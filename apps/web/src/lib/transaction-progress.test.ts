import { describe, expect, it } from "vitest";
import { transactionProgressSteps } from "./transaction-progress";

describe("transaction progress", () => {
  it("marks completed, current, and upcoming wallet phases", () => {
    expect(transactionProgressSteps("fund", "approval")).toEqual([
      {
        phase: "preparing",
        label: "Preparing exact funding",
        state: "complete",
      },
      {
        phase: "approval",
        label: "Approve GOAL funding in wallet",
        state: "current",
      },
      {
        phase: "submitting",
        label: "Submitting & confirming funding",
        state: "upcoming",
      },
    ]);
  });

  it("honestly omits wallet approval when a refund does not require it", () => {
    expect(transactionProgressSteps("refund", "submitting", false)).toEqual([
      {
        phase: "preparing",
        label: "Preparing residual refund",
        state: "complete",
      },
      {
        phase: "submitting",
        label: "Submitting & confirming refund",
        state: "current",
      },
    ]);
  });

  it.each([
    [
      "registration" as const,
      [
        "Preparing registration",
        "Approve registration signature",
        "Submitting & confirming registration",
      ],
    ],
    [
      "claim" as const,
      [
        "Preparing claim",
        "Approve claim signature",
        "Submitting & confirming claim",
      ],
    ],
  ])("describes the %s signature flow", (action, labels) => {
    expect(
      transactionProgressSteps(action, "approval").map((step) => step.label),
    ).toEqual(labels);
  });
});

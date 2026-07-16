import { describe, expect, it } from "vitest";
import { classifyRequestError } from "./app.js";

describe("HTTP failure classification", () => {
  it("returns a redacted 503 for database connection loss", () => {
    const result = classifyRequestError(
      new Error("connect ECONNREFUSED 10.0.0.12:5432"),
    );
    expect(result).toEqual({
      status: 503,
      error: "service_unavailable",
      message: "Service temporarily unavailable; retry shortly.",
    });
    expect(JSON.stringify(result)).not.toContain("10.0.0.12");
  });

  it("keeps deterministic duplicate conflicts distinct", () => {
    expect(classifyRequestError(new Error("claim already used"))).toMatchObject(
      { status: 409, error: "request_rejected" },
    );
  });
});

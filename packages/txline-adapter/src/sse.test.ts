import { describe, expect, it } from "vitest";
import { createTxlineSseParser } from "./sse.js";

describe("SSE parser", () => {
  it("preserves event IDs for resumable consumption", () => {
    const received: unknown[] = [];
    const parser = createTxlineSseParser((event) => received.push(event));
    parser.feed(
      'id: cursor-42\nevent: score\ndata: {"action":"heartbeat"}\n\n',
    );
    expect(received).toMatchObject([
      { id: "cursor-42", event: "score", data: { action: "heartbeat" } },
    ]);
  });
});

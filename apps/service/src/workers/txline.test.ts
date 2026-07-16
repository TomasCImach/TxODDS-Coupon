import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "@goaldrop/db";
import type { ServiceConfig } from "../config.js";
import {
  TxlineEntitlementError,
  authenticatedFetchWithRenewal,
  requireTxlineSuccess,
  runTxlineSupervisor,
} from "./txline.js";

describe("TxLINE transport recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renews one 401 and retries with the same cursor and new JWT", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((input: URL, init: RequestInit) => {
        requests.push({
          url: input.toString(),
          headers: new Headers(init.headers),
        });
        return Promise.resolve(new Response(null, { status: 401 }));
      })
      .mockImplementationOnce((input: URL) => {
        requests.push({ url: input.toString(), headers: new Headers() });
        return Promise.resolve(
          Response.json({ jwt: "renewed-jwt-with-sufficient-length" }),
        );
      })
      .mockImplementationOnce((input: URL, init: RequestInit) => {
        requests.push({
          url: input.toString(),
          headers: new Headers(init.headers),
        });
        return Promise.resolve(new Response("ok", { status: 200 }));
      });
    vi.stubGlobal("fetch", fetchMock);
    const credentials = {
      guestJwt: "old-jwt-with-sufficient-length",
      apiToken: "api-token",
    };

    const response = await authenticatedFetchWithRenewal(
      new URL("https://txline-dev.txodds.com/api/scores/stream"),
      {
        TXLINE_API_ORIGIN: "https://txline-dev.txodds.com",
      } as ServiceConfig,
      credentials,
      "cursor-42",
      new AbortController().signal,
    );

    expect(response.status).toBe(200);
    expect(credentials.guestJwt).toBe("renewed-jwt-with-sufficient-length");
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer old-jwt-with-sufficient-length",
    );
    expect(requests[0]?.headers.get("last-event-id")).toBe("cursor-42");
    expect(requests[2]?.headers.get("authorization")).toBe(
      "Bearer renewed-jwt-with-sufficient-length",
    );
    expect(requests[2]?.headers.get("last-event-id")).toBe("cursor-42");
  });

  it("classifies 403 as a non-retrying entitlement failure", () => {
    expect(() =>
      requireTxlineSuccess(new Response(null, { status: 403 }), "recovery"),
    ).toThrow(TxlineEntitlementError);
  });

  it("never sends TxLINE credentials to a different origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      authenticatedFetchWithRenewal(
        new URL("https://attacker.example/stream"),
        {
          TXLINE_API_ORIGIN: "https://txline-dev.txodds.com",
        } as ServiceConfig,
        { guestJwt: "guest", apiToken: "token" },
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow("different host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disabled mode makes no provider or database request", async () => {
    const fetchMock = vi.fn();
    const query = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const abort = new AbortController();
    const running = runTxlineSupervisor(
      { TXLINE_LISTENER_ENABLED: false } as ServiceConfig,
      { query } as unknown as DatabasePool,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abort.signal,
    );
    abort.abort();
    await running;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

import { createHash } from "node:crypto";
import { decideRecord, parseTxlineRecord } from "@goaldrop/txline-adapter";

const origin = process.env.TXLINE_API_ORIGIN;
let guestJwt = process.env.TXLINE_GUEST_JWT;
const apiToken = process.env.TXLINE_API_TOKEN;
const lookbackDays = Number(process.env.TXLINE_VALIDATE_DAYS ?? "14");

if (origin !== "https://txline-dev.txodds.com")
  throw new Error("live validation is pinned to the TxLINE Devnet origin");
if (!guestJwt || !apiToken)
  throw new Error("TXLINE_GUEST_JWT and TXLINE_API_TOKEN are required");
if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 14)
  throw new Error("TXLINE_VALIDATE_DAYS must be an integer from 1 through 14");

interface FixtureEnvelope {
  FixtureId?: unknown;
  StartTime?: unknown;
}

const fixtureIds = new Set<string>();
const encoder = new TextEncoder();
const currentEpochDay = Math.floor(Date.now() / 86_400_000);
let snapshotRecords = 0;

for (let offset = -lookbackDays; offset <= 0; offset += 1) {
  const url = new URL("/api/fixtures/snapshot", origin);
  url.searchParams.set("startEpochDay", String(currentEpochDay + offset));
  const response = await authenticatedFetch(url);
  requireOk(response, "fixture snapshot");
  const records = decodePayload(await response.text());
  snapshotRecords += records.length;
  for (const value of records) {
    const fixture = value as FixtureEnvelope;
    const fixtureId = String(fixture.FixtureId ?? "");
    const rawStartTime = Number(fixture.StartTime ?? 0);
    const startTime =
      rawStartTime > 10_000_000_000 ? rawStartTime : rawStartTime * 1_000;
    if (
      /^\d+$/.test(fixtureId) &&
      Number.isFinite(startTime) &&
      startTime <= Date.now() - 6 * 60 * 60 * 1_000 &&
      startTime >= Date.now() - lookbackDays * 86_400_000
    ) {
      fixtureIds.add(fixtureId);
    }
  }
}

let historicalRecords = 0;
let parseFailures = 0;
let qualifyingGoals = 0;
let terminalRecords = 0;
let correctionRecords = 0;
let ignoredRecords = 0;
const schemaShapeDigests = new Set<string>();

for (const fixtureId of fixtureIds) {
  const response = await authenticatedFetch(
    new URL(`/api/scores/historical/${fixtureId}`, origin),
  );
  requireOk(response, "historical score replay");
  for (const value of decodePayload(await response.text())) {
    historicalRecords += 1;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fieldNames = Object.keys(value).sort().join(",");
      schemaShapeDigests.add(
        createHash("sha256").update(fieldNames).digest("hex").slice(0, 16),
      );
    }
    try {
      const raw = encoder.encode(JSON.stringify(value));
      const decision = decideRecord(parseTxlineRecord(value), raw);
      if (decision.kind === "qualifying_goal") qualifyingGoals += 1;
      else if (decision.kind === "terminal") terminalRecords += 1;
      else if (decision.kind === "audit_only") correctionRecords += 1;
      else ignoredRecords += 1;
    } catch {
      parseFailures += 1;
    }
  }
}

if (fixtureIds.size === 0)
  throw new Error(
    "no historical fixtures were available in the private window",
  );
if (historicalRecords === 0)
  throw new Error("authenticated historical replay returned no records");
if (parseFailures !== 0)
  throw new Error(
    `live adapter validation rejected ${parseFailures} provider records`,
  );
if (qualifyingGoals === 0 || terminalRecords === 0 || correctionRecords === 0)
  throw new Error(
    "live validation did not cover goal, correction, and terminal semantics",
  );

process.stdout.write(
  `${JSON.stringify({
    network: "txline:devnet",
    credentialUse: "private-read-only-redacted-output",
    lookbackDays,
    snapshotRecords,
    historicalFixtures: fixtureIds.size,
    historicalRecords,
    qualifyingGoals,
    correctionRecords,
    terminalRecords,
    ignoredRecords,
    parseFailures,
    distinctSchemaShapes: schemaShapeDigests.size,
    schemaShapeDigests: [...schemaShapeDigests].sort(),
    rawPayloadPersisted: false,
  })}\n`,
);

async function authenticatedFetch(url: URL): Promise<Response> {
  let response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${guestJwt}`,
      "X-Api-Token": apiToken!,
    },
  });
  if (response.status !== 401) return response;
  const renewal = await fetch(new URL("/auth/guest/start", origin), {
    method: "POST",
  });
  requireOk(renewal, "guest JWT renewal");
  const body = (await renewal.json()) as Record<string, unknown>;
  guestJwt = String(body.jwt ?? body.token ?? body.accessToken ?? "");
  if (guestJwt.length < 20)
    throw new Error("guest JWT renewal returned an invalid credential");
  response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${guestJwt}`,
      "X-Api-Token": apiToken!,
    },
  });
  return response;
}

function requireOk(response: Response, operation: string): void {
  if (!response.ok)
    throw new Error(`${operation} returned HTTP ${response.status}`);
}

function decodePayload(text: string): unknown[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : [value];
  } catch {
    return text
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim()) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((value) => value !== undefined);
  }
}

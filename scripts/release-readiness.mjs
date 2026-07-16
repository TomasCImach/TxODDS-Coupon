import { readFileSync } from "node:fs";

const prd = readFileSync(new URL("../PRD.md", import.meta.url), "utf8");
const traceability = readFileSync(
  new URL("../docs/prd-traceability.md", import.meta.url),
  "utf8",
);
const acceptanceSection = prd.match(
  /## 18\. Acceptance Criteria(?<section>[\s\S]*?)\n---\n\n## 19\./,
)?.groups?.section;
if (!acceptanceSection)
  throw new Error("PRD §18 acceptance section could not be parsed");
const acceptanceCount = (acceptanceSection.match(/^- \[ \]/gm) ?? []).length;
const tracedIds = [...traceability.matchAll(/^\| AC-(\d{2}) \|/gm)].map(
  (match) => Number(match[1]),
);
const expectedIds = Array.from(
  { length: acceptanceCount },
  (_, index) => index + 1,
);
if (
  tracedIds.length !== acceptanceCount ||
  tracedIds.some((id, index) => id !== expectedIds[index])
) {
  process.stderr.write(
    `PRD traceability is incomplete: expected AC-01 through AC-${String(acceptanceCount).padStart(2, "0")}, found ${tracedIds.length} ordered rows.\n`,
  );
  process.exit(1);
}

const ledger = JSON.parse(
  readFileSync(
    new URL("../docs/release-blockers.json", import.meta.url),
    "utf8",
  ),
);
if (
  ledger.schemaVersion !== 1 ||
  ledger.scope !== "public-solana-devnet-mvp" ||
  !Array.isArray(ledger.blockers)
)
  throw new Error("Release blocker ledger header is invalid.");
const blockerIds = ledger.blockers.map((blocker) => blocker.id);
if (new Set(blockerIds).size !== blockerIds.length) {
  process.stderr.write("Release blocker IDs must be unique.\n");
  process.exit(1);
}
const malformed = ledger.blockers.filter(
  (blocker) =>
    typeof blocker.id !== "string" ||
    !/^RB-\d+$/.test(blocker.id) ||
    typeof blocker.title !== "string" ||
    typeof blocker.owner !== "string" ||
    typeof blocker.dueGate !== "string" ||
    !["open", "resolved"].includes(blocker.status) ||
    !Array.isArray(blocker.evidence) ||
    blocker.evidence.length === 0 ||
    blocker.evidence.some(
      (evidence) => typeof evidence !== "string" || evidence.trim() === "",
    ),
);

if (malformed.length) {
  process.stderr.write(
    `Release blocker ledger has malformed entries: ${malformed
      .map((blocker) => blocker.id ?? "<missing-id>")
      .join(", ")}\n`,
  );
  process.exit(1);
}
const open = ledger.blockers.filter((blocker) => blocker.status === "open");
if (process.argv.includes("--validate")) {
  process.stdout.write(
    `Release evidence is structurally valid: ${acceptanceCount} PRD criteria and ${ledger.blockers.length} blockers; ${open.length} blocker(s) remain open.\n`,
  );
  process.exit(0);
}
if (open.length) {
  process.stderr.write(
    `Devnet release is blocked:\n${open
      .map(
        (blocker) =>
          `- ${blocker.id}: ${blocker.title} [${blocker.status}; owner ${blocker.owner}]`,
      )
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Devnet release gate passed with ${ledger.blockers.length} resolved blockers.\n`,
);

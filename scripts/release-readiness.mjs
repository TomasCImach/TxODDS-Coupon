import { readFileSync } from "node:fs";

const ledger = JSON.parse(
  readFileSync(
    new URL("../docs/release-blockers.json", import.meta.url),
    "utf8",
  ),
);
const invalid = ledger.blockers.filter(
  (blocker) =>
    blocker.status !== "resolved" ||
    !Array.isArray(blocker.evidence) ||
    blocker.evidence.length === 0,
);

if (invalid.length) {
  process.stderr.write(
    `Devnet release is blocked:\n${invalid
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

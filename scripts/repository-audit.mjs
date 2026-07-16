import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);

if (listed.status !== 0) {
  process.stderr.write(listed.stderr);
  process.exit(listed.status ?? 1);
}

const findings = [];
const files = listed.stdout.split("\0").filter(Boolean);
const secretPatterns = [
  {
    name: "PEM private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "JWT-like credential",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: "Solana keypair byte array",
    pattern: /^\s*\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]\s*$/,
  },
];

for (const file of files) {
  const name = basename(file);
  if (/^\.env(?:\.|$)/.test(name) && name !== ".env.example") {
    findings.push(`${file}: private environment file is repository-visible`);
  }
  if (/keypair.*\.json$/i.test(name)) {
    findings.push(`${file}: keypair-shaped filename is repository-visible`);
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 1_000_000) continue;

  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const source = bytes.toString("utf8");
  for (const check of secretPatterns) {
    if (check.pattern.test(source)) findings.push(`${file}: ${check.name}`);
  }
}

const browserSources = files.filter(
  (file) => file.startsWith("apps/web/") && /\.[cm]?[jt]sx?$/.test(file),
);
for (const file of browserSources) {
  const source = readFileSync(file, "utf8");
  if (/from ["']@goaldrop\/(?:db|txline-adapter)["']/.test(source)) {
    findings.push(`${file}: browser surface imports a server-only package`);
  }
  if (
    /\b(?:localStorage|sessionStorage|indexedDB)\b/.test(source) &&
    /\bsecretKey\b/.test(source)
  ) {
    findings.push(
      `${file}: browser private-key material must not enter persistent storage`,
    );
  }
}

const composeSource = readFileSync("compose.app.yaml", "utf8");
if (/^\s*env_file:/m.test(composeSource))
  findings.push(
    "compose.app.yaml: shared env_file injection violates role-scoped secrets",
  );
const serviceSecretScopes = {
  api: ["RELAYER_KEYPAIR", "RECEIPT_CAPABILITY_KEY", "FEE_PAYER_KEYPAIR"],
  "txline-listener": [
    "TXLINE_GUEST_JWT",
    "TXLINE_API_TOKEN",
    "TXLINE_RAW_ENCRYPTION_KEY",
  ],
  "oracle-worker": ["ORACLE_KEYPAIR", "FEE_PAYER_KEYPAIR"],
  "settlement-worker": ["RELAYER_KEYPAIR", "FEE_PAYER_KEYPAIR"],
  "chain-indexer": [],
  "demo-controller": ["DEMO_AUTHORITY_KEYPAIR", "FEE_PAYER_KEYPAIR"],
  web: [],
};
const scopedSecrets = new Set(Object.values(serviceSecretScopes).flat());
const commonServiceBlock = composeSource.slice(
  0,
  composeSource.indexOf("\nservices:\n"),
);
for (const secret of scopedSecrets) {
  if (commonServiceBlock.includes(`${secret}:`))
    findings.push(
      `compose.app.yaml: ${secret} must not be injected through the shared service environment`,
    );
}
for (const [service, allowedSecrets] of Object.entries(serviceSecretScopes)) {
  const marker = `\n  ${service}:\n`;
  const start = composeSource.indexOf(marker);
  const tail = start < 0 ? "" : composeSource.slice(start + marker.length);
  const nextService = tail.search(/\n  [a-z][a-z0-9-]*:\n/);
  const block = nextService < 0 ? tail : tail.slice(0, nextService);
  if (start < 0) {
    findings.push(`compose.app.yaml: missing ${service} service`);
    continue;
  }
  for (const secret of scopedSecrets) {
    const present = block.includes(`${secret}:`);
    const expected = allowedSecrets.includes(secret);
    if (present !== expected)
      findings.push(
        `compose.app.yaml: ${service} ${present ? "must not receive" : "must receive"} ${secret}`,
      );
  }
}

for (const dockerfile of ["apps/service/Dockerfile", "apps/web/Dockerfile"]) {
  const source = readFileSync(dockerfile, "utf8");
  const nodeBases = source.match(/^FROM\s+node:[^\s]+/gm) ?? [];
  if (
    nodeBases.length !== 2 ||
    nodeBases.some((base) => !/@sha256:[a-f0-9]{64}$/.test(base))
  )
    findings.push(
      `${dockerfile}: builder and runtime Node images must use immutable SHA-256 digests`,
    );
}

const workflowSource = readFileSync(".github/workflows/verify.yml", "utf8");
for (const action of workflowSource.matchAll(/^\s*- uses:\s+([^\s#]+)/gm)) {
  if (!/@[a-f0-9]{40}$/.test(action[1] ?? ""))
    findings.push(
      `.github/workflows/verify.yml: action ${action[1]} must be pinned to a full commit SHA`,
    );
}
for (const digest of [
  "5f25b850ce80278507a98947833fcd48423391f6d145046ffb0c5fd130dec436",
  "56241fbe862495ff01b2b875195e44f94c22e9f2a504591a3ade1b9d82862730",
]) {
  if (!workflowSource.includes(digest))
    findings.push(
      ".github/workflows/verify.yml: pinned Anchor/Agave download checksum is missing",
    );
}

if (findings.length) {
  process.stderr.write(
    `Repository security audit failed:\n${findings.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Repository security audit passed (${files.length} visible files, ${browserSources.length} web source files).\n`,
);

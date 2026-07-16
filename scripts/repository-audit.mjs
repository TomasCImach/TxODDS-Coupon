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

if (findings.length) {
  process.stderr.write(
    `Repository security audit failed:\n${findings.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Repository security audit passed (${files.length} visible files, ${browserSources.length} web source files).\n`,
);

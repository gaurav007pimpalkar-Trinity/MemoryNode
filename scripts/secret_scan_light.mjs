#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const patterns = [
  { re: /sk_live_[0-9a-zA-Z]{10,}/, label: "stripe_live" },
  { re: /sk_test_[0-9a-zA-Z]{10,}/, label: "stripe_test" },
  { re: /BEGIN [A-Z ]*PRIVATE KEY/, label: "private_key" },
  // Credentialed Postgres URLs (user:pass@host); avoid false positives on docs-only examples by allowing opt-out via file ignore below.
  { re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@[^ \s]+/i, label: "postgres_url" },
  // JWT-like Supabase service role values; do not match the identifier alone.
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, label: "supabase_service_role_jwt" },
];

const excludedDirs = new Set(["node_modules", ".git", ".pnpm-store", ".tmp", "dist", "build"]);
const excludedFiles = [
  /^docs[\\/].*\.md$/i, // allow docs to show placeholder URLs without failing CI
  /^\.env\.(staging|prod)\.smoke(\.example)?$/i,
  /^\.env\.gate(\.example)?$/i,
];

let failed = false;

function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (excludedDirs.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else {
      const rel = path.relative(process.cwd(), full);
      if (excludedFiles.some((re) => re.test(rel))) continue;
      const content = fs.readFileSync(full, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        // Ignore GitHub Actions secret/env substitutions and empty placeholders.
        if (/\$\{\{\s*(secrets|env)\./i.test(line)) return;
        if (/=\s*$/.test(line) || /=\s*["']?\s*["']?\s*$/.test(line)) return;
        for (const pat of patterns) {
          const match = line.match(pat.re);
          if (match) {
            if (pat.label === "postgres_url") {
              const val = match[0];
              if (/(USER|PASSWORD|HOST|DBNAME|DATABASE|EXAMPLE|CHANGE|REPLACE)/i.test(val)) {
                return; // placeholder, not a real secret
              }
            }
            const redacted =
              line.length > 12 ? `${line.slice(0, 4)}***${line.slice(-4)}` : "***";
            console.error(`${rel}:${idx + 1}: ${pat.label} pattern detected (${redacted})`);
            failed = true;
          }
        }
      });
    }
  }
}

walk(process.cwd());

if (failed) process.exit(1);
console.log("Secret light scan passed (no common secret patterns found).");

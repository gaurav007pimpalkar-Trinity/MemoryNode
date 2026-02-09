#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const patterns = [
  { re: /sk_live_[0-9a-zA-Z]{10,}/, label: "stripe_live" },
  { re: /sk_test_[0-9a-zA-Z]{10,}/, label: "stripe_test" },
  { re: /BEGIN [A-Z ]*PRIVATE KEY/, label: "private_key" },
  { re: /postgres:\/\/[^ \n]+/i, label: "postgres_url" },
  { re: /SUPABASE_SERVICE_ROLE_KEY/i, label: "supabase_service_role" },
];

const excludedDirs = new Set(["node_modules", ".git", ".pnpm-store", ".tmp", "dist", "build"]);

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
      const content = fs.readFileSync(full, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const pat of patterns) {
          if (pat.re.test(line)) {
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

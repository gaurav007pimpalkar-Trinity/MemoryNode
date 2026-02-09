#!/usr/bin/env node
import fs from "node:fs";

const targets = fs.readdirSync(".").filter((f) => f.startsWith(".env") && f.endsWith(".example"));
let failed = false;

function checkFile(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!line || line.trim().startsWith("#")) return;
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) return;
    const val = rest.join("=").trim();
    if (val) {
      console.error(`${file}:${idx + 1}: value should be empty (found something after '=')`);
      failed = true;
    }
    const lc = val.toLowerCase();
    const patterns = ["sk_live", "sk_test", "mn_", "postgres://"];
    if (patterns.some((p) => lc.includes(p))) {
      console.error(`${file}:${idx + 1}: suspicious placeholder/value '${val.slice(0, 4)}***'`);
      failed = true;
    }
  });
}

targets.forEach(checkFile);

if (failed) process.exit(1);
console.log("Example env files are clean (no values).");

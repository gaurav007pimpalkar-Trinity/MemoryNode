#!/usr/bin/env node
import fs from "node:fs";

const examplePath = ".env.staging.smoke.example";

function main() {
  if (!fs.existsSync(examplePath)) {
    console.error(`[staging:setup] Missing ${examplePath}.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(examplePath, "utf8").split(/\r?\n/).filter(Boolean);
  console.log("Staging Setup Checklist");
  console.log("-----------------------");
  console.log("Copy .env.staging.smoke.example -> .env.staging.smoke, then fill values:");
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const [key] = line.split("=", 1);
    const comment = line.includes("#") ? line.split("#")[1] : "";
    const desc = comment ? comment.trim() : "";
    console.log(`- ${key}${desc ? ` — ${desc}` : ""}`);
  }
  console.log("\nWhen filled, run: pnpm staging:release-check");
}

main();

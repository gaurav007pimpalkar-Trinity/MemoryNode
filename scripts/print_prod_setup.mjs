#!/usr/bin/env node
import fs from "node:fs";

const examplePath = ".env.prod.smoke.example";

function main() {
  if (!fs.existsSync(examplePath)) {
    console.error(`[prod:setup] Missing ${examplePath}.`);
    process.exit(1);
  }
  const lines = fs.readFileSync(examplePath, "utf8").split(/\r?\n/).filter(Boolean);
  console.log("Production Setup Checklist");
  console.log("---------------------------");
  console.log("Copy .env.prod.smoke.example -> .env.prod.smoke, then fill values:");
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const [key] = line.split("=", 1);
    const comment = line.includes("#") ? line.split("#")[1] : "";
    const desc = comment ? comment.trim() : "";
    console.log(`- ${key}${desc ? ` — ${desc}` : ""}`);
  }
  console.log("\nWhen filled, run: pnpm prod:gate && pnpm prod:release-check");
}

main();

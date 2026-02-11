#!/usr/bin/env node
import { getMigrationManifest, formatManifestSummary } from "./lib/migrations_manifest.mjs";

function main() {
  const manifest = getMigrationManifest();
  console.log(formatManifestSummary(manifest));
  for (const file of manifest.files) {
    console.log(`- ${file}`);
  }
}

main();

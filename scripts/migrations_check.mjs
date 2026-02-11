#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  formatManifestSummary,
  getMigrationManifest,
  validateMigrationSequence,
} from "./lib/migrations_manifest.mjs";

const DOCS_REQUIRE_MANIFEST = [
  "docs/README.md",
  "docs/QUICKSTART.md",
  "docs/LAUNCH_CHECKLIST.md",
];

function failWithIssues(issues) {
  console.error("Migration check failed:");
  for (const issue of issues) {
    console.error(` - ${issue}`);
  }
  process.exit(1);
}

function readText(filePath) {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function checkDocsManifestTokens(manifest, issues) {
  for (const docPath of DOCS_REQUIRE_MANIFEST) {
    const text = readText(docPath);
    const hasCount = text.includes(`MIGRATIONS_TOTAL=${manifest.count}`);
    const hasLatest = text.includes(`MIGRATIONS_LATEST=${manifest.latestFile}`);
    if (!hasCount || !hasLatest) {
      issues.push(
        `${docPath} is missing current migration manifest tokens. Expected ${formatManifestSummary(manifest)}.`,
      );
    }
  }
}

function checkNoStaleRangeMentions(manifest, issues) {
  const docsRoot = path.resolve("docs");
  const stack = [docsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
      const lines = readText(rel).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (
          line.includes("001_init.sql") &&
          line.includes("016_webhook_events.sql") &&
          !line.includes(manifest.latestFile)
        ) {
          issues.push(
            `${rel}:${i + 1} appears to hard-code an outdated migration range ending at 016_webhook_events.sql.`,
          );
        }
      }
    }
  }
}

function checkRunnerIsDynamic(issues) {
  const dbMigrateRaw = readText("scripts/db_migrate.mjs");
  if (!dbMigrateRaw.includes("listMigrationFiles")) {
    issues.push(
      "scripts/db_migrate.mjs is not using shared filesystem migration discovery (listMigrationFiles).",
    );
  }
}

function main() {
  const manifest = getMigrationManifest();
  const issues = [];

  issues.push(...validateMigrationSequence(manifest.files));
  if (!manifest.latestFile) {
    issues.push("No latest migration file detected.");
  }

  checkRunnerIsDynamic(issues);
  checkDocsManifestTokens(manifest, issues);
  checkNoStaleRangeMentions(manifest, issues);

  if (issues.length > 0) {
    failWithIssues(issues);
  }

  console.log(`Migration check passed. ${formatManifestSummary(manifest)}`);
}

main();

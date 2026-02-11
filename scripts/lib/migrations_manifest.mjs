#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

export const MIGRATIONS_DIR = path.resolve("infra/sql");
export const MIGRATION_FILENAME_RE = /^(\d+)_.*\.sql$/;
const VERIFY_FILE = "verify_rls.sql";

export function isMigrationFilename(filename) {
  if (filename === VERIFY_FILE) return false;
  return MIGRATION_FILENAME_RE.test(filename);
}

export function parseMigrationNumber(filename) {
  const match = filename.match(MIGRATION_FILENAME_RE);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function compareMigrations(a, b) {
  const aNum = parseMigrationNumber(a) ?? 0;
  const bNum = parseMigrationNumber(b) ?? 0;
  if (aNum !== bNum) return aNum - bNum;

  const aIsRpc = /_rpc\.sql$/i.test(a);
  const bIsRpc = /_rpc\.sql$/i.test(b);
  if (aIsRpc !== bIsRpc) return aIsRpc ? 1 : -1;

  return a.localeCompare(b, "en", { numeric: true });
}

export function listMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  return files.filter(isMigrationFilename).sort(compareMigrations);
}

export function getMigrationManifest() {
  const files = listMigrationFiles();
  const numbers = [...new Set(files.map((f) => parseMigrationNumber(f)).filter((n) => n !== null))];
  const latestFile = files.length ? files[files.length - 1] : null;
  const latestNumber = latestFile ? parseMigrationNumber(latestFile) : null;
  return {
    files,
    numbers,
    count: files.length,
    latestFile,
    latestNumber,
  };
}

export function validateMigrationSequence(files) {
  const issues = [];
  if (!files.length) {
    issues.push("No migration files found in infra/sql.");
    return issues;
  }

  const numbers = [...new Set(files.map((f) => parseMigrationNumber(f)).filter((n) => n !== null))];
  numbers.sort((a, b) => a - b);

  if (numbers[0] !== 1) {
    issues.push(`Migration numbering must start at 1; found ${numbers[0]}.`);
  }

  for (let i = 0; i < numbers.length - 1; i += 1) {
    const current = numbers[i];
    const next = numbers[i + 1];
    if (next !== current + 1) {
      issues.push(`Migration numbering gap detected between ${current} and ${next}.`);
    }
  }

  const badNames = files.filter((f) => !MIGRATION_FILENAME_RE.test(f));
  if (badNames.length > 0) {
    issues.push(`Unexpected migration filename format: ${badNames.join(", ")}`);
  }

  return issues;
}

export function formatManifestSummary(manifest) {
  const latest = manifest.latestFile ?? "<none>";
  return `MIGRATIONS_TOTAL=${manifest.count}; MIGRATIONS_LATEST=${latest}`;
}

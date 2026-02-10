#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function validateDbUrl(raw) {
  if (!raw) {
    fail("Missing SUPABASE_DB_URL (or DATABASE_URL) environment variable.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(
      "Invalid DATABASE_URL format. Expected like: postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require",
    );
  }
  const host = (parsed.hostname || "").toLowerCase();
  const badHosts = ["host", "example.com", "localhost", "127.0.0.1"];
  const rawLower = raw.toLowerCase();
  const allowLocalDb = process.env.ALLOW_LOCAL_DB_URL === "1";
  if (
    (!allowLocalDb && badHosts.includes(host)) ||
    rawLower.includes("your_") ||
    rawLower.includes("replace_me") ||
    rawLower.includes("changeme")
  ) {
    fail(
      `DATABASE_URL appears to be a placeholder (${parsed.hostname}). Set a real Postgres URL, e.g. postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require (Supabase often requires sslmode=require or pooler host). Check .env.staging.smoke/.env.gate.`,
    );
  }
  return parsed.toString();
}

const validatedDbUrl = validateDbUrl(dbUrl);

const migrationsDir = path.resolve("infra/sql");
const migrationTable = "memorynode_migrations";

function listMigrations() {
  const files = fs.readdirSync(migrationsDir);
  const ordered = files
    .filter((f) => /^\d+_.*\.sql$/.test(f) && f !== "verify_rls.sql")
    .sort((a, b) => {
      const [, aNum] = a.match(/^(\d+)_/) || [];
      const [, bNum] = b.match(/^(\d+)_/) || [];
      const aInt = parseInt(aNum || "0", 10);
      const bInt = parseInt(bNum || "0", 10);
      if (aInt !== bInt) return aInt - bInt;
      const aIsRpc = /_rpc\.sql$/i.test(a);
      const bIsRpc = /_rpc\.sql$/i.test(b);
      if (aIsRpc !== bIsRpc) return aIsRpc ? 1 : -1; // non-RPC before RPC within same prefix
      return a.localeCompare(b, "en", { numeric: true });
    });

  if (process.env.DEBUG_MIGRATIONS === "1") {
    console.log("Migration order:\n" + ordered.join("\n"));
  }

  return ordered;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function ensureTable(client) {
  await client.query(`
    create table if not exists ${migrationTable} (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function markMigrationApplied(client, filename, checksum) {
  await client.query(
    `insert into ${migrationTable} (filename, checksum) values ($1, $2)`,
    [filename, checksum],
  );
}

async function bumpUsageReturnType(client) {
  const res = await client.query(`
    select pg_get_function_result(
      to_regprocedure('public.bump_usage(uuid,date,integer,integer,integer)')
    ) as result_type
  `);
  return (res.rows?.[0]?.result_type ?? "").trim();
}

async function legacySkipReason(client, filename) {
  if (filename !== "003_usage.sql" && filename !== "003_usage_rpc.sql") {
    return null;
  }

  const resultType = await bumpUsageReturnType(client);
  const normalized = resultType.toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }

  if (filename === "003_usage.sql" && normalized !== "usage_daily") {
    return `legacy bump_usage already exists with return type "${resultType}"`;
  }

  if (filename === "003_usage_rpc.sql" && normalized === "usage_daily") {
    return "canonical bump_usage already exists";
  }

  return null;
}

async function applyMigration(client, filename) {
  const fullPath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(fullPath, "utf8");
  const checksum = sha256(sql);

  const existing = await client.query(
    `select checksum from ${migrationTable} where filename = $1`,
    [filename],
  );

  if (existing.rows.length) {
    const stored = existing.rows[0].checksum;
    if (stored !== checksum) {
      throw new Error(
        `Checksum drift detected for ${filename}. Expected ${stored} but found ${checksum}.`,
      );
    }
    console.log(`SKIP  ${filename} (already applied)`);
    return;
  }

  const skipReason = await legacySkipReason(client, filename);
  if (skipReason) {
    console.log(`SKIP  ${filename} (${skipReason}; normalized by later repair migration)`);
    await markMigrationApplied(client, filename, checksum);
    return;
  }

  console.log(`APPLY ${filename}`);
  await client.query(sql);
  await markMigrationApplied(client, filename, checksum);
}

async function main() {
  const client = new Client({
    connectionString: validatedDbUrl,
    ssl: validatedDbUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    await ensureTable(client);
    const migrations = listMigrations();
    for (const file of migrations) {
      await applyMigration(client, file);
    }
    console.log("All migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

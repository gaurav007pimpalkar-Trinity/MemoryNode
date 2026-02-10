#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const migrationsDir = path.resolve("infra/sql");
const migrationTable = "memorynode_migrations";
const adminUrl = process.env.MIGRATION_TEST_ADMIN_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

function checksum(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runNodeScript(scriptPath, dbUrl) {
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      ALLOW_LOCAL_DB_URL: "1",
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed with exit code ${result.status}`);
  }
}

function databaseUrl(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withClient(connectionString, fn) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabase(name) {
  await withClient(adminUrl, async (client) => {
    await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1
         and pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`drop database if exists "${name}"`);
    await client.query(`create database "${name}"`);
  });
}

async function dropDatabase(name) {
  await withClient(adminUrl, async (client) => {
    await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1
         and pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`drop database if exists "${name}"`);
  });
}

async function bootstrapAuthSchema(dbUrl) {
  await withClient(dbUrl, async (client) => {
    await client.query(`
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid
      language sql stable as $$ select null::uuid $$;
      create or replace function auth.role() returns text
      language sql stable as $$ select 'service_role'::text $$;
      create or replace function auth.jwt() returns jsonb
      language sql stable as $$ select '{}'::jsonb $$;
    `);
  });
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists ${migrationTable} (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function applyAndMark(client, filename) {
  const sqlPath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(sqlPath, "utf8");
  await client.query(sql);
  await client.query(
    `insert into ${migrationTable} (filename, checksum) values ($1, $2)`,
    [filename, checksum(sql)],
  );
}

async function seedLegacyPartialState(dbUrl) {
  await withClient(dbUrl, async (client) => {
    await ensureMigrationTable(client);
    await applyAndMark(client, "001_init.sql");
    await applyAndMark(client, "002_rpc.sql");
    // Legacy state: one branch recorded, the other pending.
    await applyAndMark(client, "003_usage_rpc.sql");
  });
}

async function main() {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`.replace(/[^a-zA-Z0-9_]/g, "_");
  const freshDb = `mn_fresh_${suffix}`;
  const partialDb = `mn_partial_${suffix}`;
  const freshUrl = databaseUrl(adminUrl, freshDb);
  const partialUrl = databaseUrl(adminUrl, partialDb);

  try {
    console.log(`[drift-test] creating fresh database: ${freshDb}`);
    await recreateDatabase(freshDb);
    await bootstrapAuthSchema(freshUrl);
    runNodeScript("scripts/db_migrate.mjs", freshUrl);
    runNodeScript("scripts/db_verify_rls.mjs", freshUrl);

    console.log(`[drift-test] creating partial database: ${partialDb}`);
    await recreateDatabase(partialDb);
    await bootstrapAuthSchema(partialUrl);
    await seedLegacyPartialState(partialUrl);
    runNodeScript("scripts/db_migrate.mjs", partialUrl);
    runNodeScript("scripts/db_verify_rls.mjs", partialUrl);

    console.log("[drift-test] migration drift check passed on fresh + legacy-partial states.");
  } finally {
    await dropDatabase(freshDb).catch(() => {});
    await dropDatabase(partialDb).catch(() => {});
  }
}

main().catch((error) => {
  fail(error?.message || String(error));
});

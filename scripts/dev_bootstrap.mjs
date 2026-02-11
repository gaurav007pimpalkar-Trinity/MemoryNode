#!/usr/bin/env node
import { execSync } from "node:child_process";

const baseUrl = process.env.MN_BASE_URL || "http://127.0.0.1:8787";
const adminToken = process.env.MASTER_ADMIN_TOKEN;
const workspaceName = process.env.WORKSPACE_NAME || "Local Workspace";
const apiKeyName = process.env.API_KEY_NAME || "default";
const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
const skipDbChecks = process.env.BOOTSTRAP_SKIP_DB_CHECKS === "1";

if (!adminToken) {
  console.error("MASTER_ADMIN_TOKEN is required in env");
  process.exit(1);
}

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: process.env });
}

function runDbBootstrapChecks() {
  if (skipDbChecks) {
    console.log("Skipping db bootstrap checks (BOOTSTRAP_SKIP_DB_CHECKS=1).");
    return;
  }
  if (!dbUrl) {
    console.log("Skipping db bootstrap checks (SUPABASE_DB_URL/DATABASE_URL not set).");
    return;
  }
  run("pnpm db:migrate");
  run("pnpm db:verify-rls");
  run("pnpm db:verify-schema");
}

async function main() {
  runDbBootstrapChecks();

  const headers = { "content-type": "application/json", "x-admin-token": adminToken };

  const wsRes = await fetch(`${baseUrl}/v1/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: workspaceName }),
  });

  if (!wsRes.ok) {
    console.error("Failed to create workspace:", await wsRes.text());
    process.exit(1);
  }
  const workspace = await wsRes.json();

  const keyRes = await fetch(`${baseUrl}/v1/api-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace_id: workspace.workspace_id, name: apiKeyName }),
  });
  if (!keyRes.ok) {
    console.error("Failed to create api key:", await keyRes.text());
    process.exit(1);
  }
  const key = await keyRes.json();

  console.log("Workspace created:", workspace.workspace_id);
  console.log("API key (save securely, shown once):", key.api_key);
  console.log("\nSample curl:");
  console.log(
    `curl -X POST ${baseUrl}/v1/memories -H "x-api-key: ${key.api_key}" -H "content-type: application/json" -d '{\"user_id\":\"user-123\",\"text\":\"hello memory\"}'`,
  );
  console.log(
    `curl -X POST ${baseUrl}/v1/context -H "x-api-key: ${key.api_key}" -H "content-type: application/json" -d '{\"user_id\":\"user-123\",\"query\":\"hello\"}'`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

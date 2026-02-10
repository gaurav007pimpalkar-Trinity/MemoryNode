import { describe, expect, it } from "vitest";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

const envBase = {
  SUPABASE_MODE: "stub",
  // Keep stub DB mode, but avoid raw-key auth bypass (it only activates when SUPABASE_URL === "stub").
  SUPABASE_URL: "https://stub.local",
  SUPABASE_SERVICE_ROLE_KEY: "stub",
  OPENAI_API_KEY: "sk-stub",
  API_KEY_SALT: "",
  MASTER_ADMIN_TOKEN: "admin",
  EMBEDDINGS_MODE: "stub",
  RATE_LIMIT_DO: rateLimitDo as unknown as DurableObjectNamespace,
} satisfies Record<string, unknown>;

describe("admin API key hash regression", () => {
  it("authenticates immediately with an API key created by admin route", async () => {
    const wsRes = await api.fetch(
      new Request("http://localhost/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ name: "hash-regression" }),
      }),
      envBase as unknown as Record<string, unknown>,
    );
    expect(wsRes.status).toBe(200);
    const wsJson = await wsRes.json();
    const workspaceId = wsJson.workspace_id as string;

    const keyRes = await api.fetch(
      new Request("http://localhost/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": "admin" },
        body: JSON.stringify({ workspace_id: workspaceId, name: "regression-key" }),
      }),
      envBase as unknown as Record<string, unknown>,
    );
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    const apiKey = keyJson.api_key as string;
    expect(apiKey).toMatch(/^mn_live_/);

    const usageRes = await api.fetch(
      new Request("http://localhost/v1/usage/today", {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      envBase as unknown as Record<string, unknown>,
    );
    expect(usageRes.status).toBe(200);
  });
});

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleBillingStatus,
  handleBillingCheckout,
  handleBillingPortal,
  handleBillingWebhook,
  handleUsageToday,
  handleSearch,
  handleCreateMemory,
  handleContext,
} from "../src/index.js";
import { capsByPlan } from "../src/limits.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateLimitDo = makeRateLimitDoStub();

type WorkspaceRow = {
  id: string;
  plan: "free" | "pro" | "team";
  plan_status: "free" | "trialing" | "active" | "past_due" | "canceled";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_provider: string;
  payu_txn_id: string | null;
  payu_payment_id: string | null;
  payu_last_status: string | null;
  payu_last_event_id: string | null;
  payu_last_event_created: number | null;
};

type PayUWebhookRow = {
  event_id: string;
  status?: string | null;
  event_type?: string | null;
  event_created?: number | null;
  processed_at?: string | null;
  request_id?: string | null;
  workspace_id?: string | null;
  txn_id?: string | null;
  payment_id?: string | null;
  payu_status?: string | null;
  defer_reason?: string | null;
  last_error?: string | null;
  payload?: Record<string, unknown>;
};

function makeSupabase(options?: {
  plan?: WorkspaceRow["plan"];
  plan_status?: WorkspaceRow["plan_status"];
  workspace?: Partial<WorkspaceRow>;
  usage?: { writes: number; reads: number; embeds: number };
  failWorkspaceUpdates?: number;
}) {
  const workspace: WorkspaceRow = {
    id: options?.workspace?.id ?? "ws1",
    plan: options?.plan ?? options?.workspace?.plan ?? "free",
    plan_status: options?.plan_status ?? options?.workspace?.plan_status ?? "free",
    current_period_end: options?.workspace?.current_period_end ?? null,
    cancel_at_period_end: options?.workspace?.cancel_at_period_end ?? false,
    billing_provider: options?.workspace?.billing_provider ?? "payu",
    payu_txn_id: options?.workspace?.payu_txn_id ?? null,
    payu_payment_id: options?.workspace?.payu_payment_id ?? null,
    payu_last_status: options?.workspace?.payu_last_status ?? null,
    payu_last_event_id: options?.workspace?.payu_last_event_id ?? null,
    payu_last_event_created: options?.workspace?.payu_last_event_created ?? null,
  };

  const usage = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };
  const payuEvents = new Map<string, PayUWebhookRow>();
  let billingUpdateCount = 0;
  let remainingWorkspaceUpdateFailures = options?.failWorkspaceUpdates ?? 0;

  return {
    workspace,
    getBillingUpdateCount: () => billingUpdateCount,
    getWebhookRow: (eventId: string) => payuEvents.get(eventId),
    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            limit: () => ({
              single: async () => ({ data: { api_key_salt: "salt" }, error: null }),
            }),
          }),
        };
      }
      if (table === "api_keys") {
        const builder = {
          eq: () => builder,
          is: () => builder,
          single: async () => ({
            data: { id: "k1", workspace_id: workspace.id, workspaces: { plan: workspace.plan, plan_status: workspace.plan_status } },
            error: null,
          }),
        };
        return {
          select: () => builder,
        };
      }
      if (table === "workspaces") {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          select: () => builder,
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            return builder;
          },
          maybeSingle: async () => {
            const matches = filters.every(([col, val]) => (workspace as Record<string, unknown>)[col] === val);
            return { data: matches ? workspace : null, error: null };
          },
          single: async () => ({ data: workspace, error: null }),
          update: (fields: Partial<WorkspaceRow>) => ({
            eq: () => {
              if (remainingWorkspaceUpdateFailures > 0) {
                remainingWorkspaceUpdateFailures -= 1;
                return { data: null, error: { message: "transient workspace update failure" } };
              }
              billingUpdateCount += 1;
              Object.assign(workspace, fields);
              return { data: [workspace], error: null };
            },
          }),
        };
        return builder;
      }
      if (table === "usage_daily") {
        const builder = {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: usage, error: null }),
              }),
            }),
          }),
        };
        return builder;
      }
      if (table === "memories") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: {}, error: null }) }) }),
        };
      }
      if (table === "memory_chunks") {
        return {
          insert: () => ({ error: null }),
        };
      }
      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          insert: (rows: unknown) => {
            void rows;
            return { error: null };
          },
        };
      }
      if (table === "payu_webhook_events") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({
                data: payuEvents.get(String(val)) ?? null,
                error: null,
              }),
            }),
          }),
          insert: (rows: Array<PayUWebhookRow> | PayUWebhookRow) => {
            const list = Array.isArray(rows) ? rows : [rows];
            const row = list[0];
            return {
              select: () => {
                const runner = async () => {
                  if (payuEvents.has(row.event_id)) {
                    return { data: null, error: { code: "23505", message: "duplicate" } };
                  }
                  payuEvents.set(row.event_id, { ...row });
                  return { data: payuEvents.get(row.event_id) ?? null, error: null };
                };
                return {
                  maybeSingle: runner,
                  single: runner,
                };
              },
            };
          },
          update: (fields: Partial<PayUWebhookRow>) => ({
            eq: (_col: string, val: unknown) => {
              const key = String(val);
              const existing = payuEvents.get(key);
              if (existing) Object.assign(existing, fields);
              return { data: existing ? [existing] : [], error: null };
            },
          }),
          order: () => ({
            limit: async () => ({ data: Array.from(payuEvents.values()), error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc() {
      return { data: [], error: null };
    },
  } as unknown as SupabaseClient & {
    workspace: WorkspaceRow;
    getBillingUpdateCount: () => number;
    getWebhookRow: (eventId: string) => PayUWebhookRow | undefined;
  };
}

function makeEnv(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENAI_API_KEY: "",
    API_KEY_SALT: "salt",
    MASTER_ADMIN_TOKEN: "",
    RATE_LIMIT_DO: rateLimitDo,
    PAYU_MERCHANT_KEY: "payu_key",
    PAYU_MERCHANT_SALT: "payu_salt",
    PAYU_BASE_URL: "https://secure.payu.in/_payment",
    PAYU_PRO_AMOUNT: "49.00",
    PAYU_PRODUCT_INFO: "MemoryNode Platform Pro",
    PUBLIC_APP_URL: "https://app.example.com",
    ...overrides,
  };
}

function signPayUWebhook(payload: Record<string, string>, env = makeEnv()) {
  const sequence = [
    String(env.PAYU_MERCHANT_SALT ?? ""),
    payload.status ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    payload.udf1 ?? "",
    payload.email ?? "",
    payload.firstname ?? "",
    payload.productinfo ?? "",
    payload.amount ?? "",
    payload.txnid ?? "",
    String(env.PAYU_MERCHANT_KEY ?? ""),
  ].join("|");
  return crypto.createHash("sha512").update(sequence).digest("hex");
}

describe("billing status", () => {
  it("returns billing status for workspace", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const res = await handleBillingStatus(req, makeEnv(), makeSupabase({ plan: "pro", plan_status: "trialing" }) as SupabaseClient, {});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.plan).toBe("pro");
    expect(json.plan_status).toBe("trialing");
    expect(json.cancel_at_period_end).toBe(false);
  });

  it("fails gracefully when PayU env is missing", async () => {
    const req = new Request("http://localhost/v1/billing/status", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });

    const res = await handleBillingStatus(
      req,
      makeEnv({ ENVIRONMENT: "production", PAYU_MERCHANT_KEY: undefined, PAYU_MERCHANT_SALT: undefined, PAYU_BASE_URL: undefined, PUBLIC_APP_URL: undefined }),
      makeSupabase({ plan: "pro", plan_status: "active" }) as SupabaseClient,
      {},
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("BILLING_NOT_CONFIGURED");
    expect(String(json.error.message)).toContain("Missing PayU configuration");
  });
});

describe("non-billing endpoints without PayU config", () => {
  it("usage endpoint still works when PayU vars are missing", async () => {
    const req = new Request("http://localhost/v1/usage/today", {
      method: "GET",
      headers: { authorization: "Bearer mn_live_test" },
    });
    const res = await handleUsageToday(
      req,
      makeEnv({
        PAYU_MERCHANT_KEY: undefined,
        PAYU_MERCHANT_SALT: undefined,
        PAYU_BASE_URL: undefined,
        PUBLIC_APP_URL: undefined,
      }),
      makeSupabase() as SupabaseClient,
      {},
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.writes).toBeDefined();
  });
});

describe("billing checkout + portal", () => {
  it("returns PayU checkout payload and stores txn id", async () => {
    const supabase = makeSupabase({ plan: "free", plan_status: "free" });

    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.provider).toBe("payu");
    expect(json.method).toBe("POST");
    expect(json.url).toContain("payu");
    expect(json.fields).toBeTruthy();
    expect(typeof json.fields.hash).toBe("string");
    expect(supabase.workspace.payu_txn_id).toMatch(/^mn/);
  });

  it("rejects team plan because platform-only billing is enforced", async () => {
    const res = await handleBillingCheckout(
      new Request("http://localhost/v1/billing/checkout", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ plan: "team" }),
      }),
      makeEnv(),
      makeSupabase() as SupabaseClient,
      {},
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("PLAN_NOT_SUPPORTED");
  });

  it("portal endpoint is gone", async () => {
    const res = await handleBillingPortal(
      new Request("http://localhost/v1/billing/portal", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test" },
      }),
      makeEnv(),
      makeSupabase(),
      {},
    );
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error.code).toBe("GONE");
  });
});

describe("billing webhook", () => {
  it("rejects invalid signature", async () => {
    const payload = {
      key: "payu_key",
      txnid: "txn_bad_sig",
      mihpayid: "mih_bad_sig",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform Pro",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
      hash: "invalid",
    };

    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      makeEnv(),
      makeSupabase() as SupabaseClient,
      "req-sig",
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { request_id?: string; error: { code: string } };
    expect(json.error.code).toBe("invalid_webhook_signature");
    expect(json.request_id).toBe("req-sig");
  });

  it("updates workspace on successful payment", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_success_1",
      mihpayid: "mihpay_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform Pro",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-ok",
    );

    expect(res.status).toBe(200);
    expect(supabase.workspace.plan).toBe("pro");
    expect(supabase.workspace.plan_status).toBe("active");
    expect(supabase.workspace.payu_txn_id).toBe("txn_success_1");
    expect(supabase.workspace.payu_payment_id).toBe("mihpay_1");
    expect(supabase.workspace.payu_last_status).toBe("success");
  });

  it("treats replayed webhook event ids as no-op", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_replay_1",
      mihpayid: "mihpay_replay_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform Pro",
      firstname: "MemoryNode",
      email: "ws1@example.com",
      udf1: "ws1",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    const req = () =>
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const first = await handleBillingWebhook(req(), env, supabase, "req-replay-1");
    const second = await handleBillingWebhook(req(), env, supabase, "req-replay-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(supabase.workspace.payu_last_event_id).toBe("mihpay_replay_1");
    expect(supabase.getBillingUpdateCount()).toBe(1);
  });

  it("stores workspace-missing webhook as deferred", async () => {
    const env = makeEnv();
    const payload = {
      key: String(env.PAYU_MERCHANT_KEY),
      txnid: "txn_deferred_1",
      mihpayid: "mihpay_deferred_1",
      status: "success",
      amount: "49.00",
      productinfo: "MemoryNode Platform Pro",
      firstname: "MemoryNode",
      email: "missing@example.com",
      udf1: "ws-missing",
    } as Record<string, string>;
    payload.hash = signPayUWebhook(payload, env);

    const supabase = makeSupabase();
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      supabase,
      "req-deferred",
    );

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.error.code).toBe("webhook_deferred");
    expect(supabase.getWebhookRow("mihpay_deferred_1")?.status).toBe("deferred");
  });
});

describe("cap enforcement upgrade path", () => {
  it("returns 402 with upgrade info and effective plan", async () => {
    const usageAtCap = { writes: 0, reads: capsByPlan.free.reads, embeds: capsByPlan.free.embeds };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "past_due",
      usage: usageAtCap,
    });

    const res = await handleSearch(
      new Request("http://localhost/v1/search", {
        method: "POST",
        headers: { authorization: "Bearer mn_live_test", "content-type": "application/json" },
        body: JSON.stringify({ user_id: "u1", query: "hello" }),
      }),
      makeEnv({ PUBLIC_APP_URL: "https://app.example.com" }) as Record<string, unknown>,
      supabase,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
    expect(json.error.upgrade_url).toContain("/settings/billing");
  });

  it("memories cap uses effective plan when past_due", async () => {
    const usageAtCap = {
      writes: capsByPlan.free.writes,
      reads: capsByPlan.free.reads,
      embeds: capsByPlan.free.embeds,
    };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "past_due",
      usage: usageAtCap,
    });

    const res = await handleCreateMemory(
      new Request("http://localhost/v1/memories", {
        method: "POST",
        headers: {
          authorization: "Bearer mn_live_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_id: "u1", text: "hello world" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
  });

  it("context cap uses effective plan when canceled", async () => {
    const usageAtCap = { writes: 0, reads: capsByPlan.free.reads, embeds: capsByPlan.free.embeds };
    const supabase = makeSupabase({
      plan: "pro",
      plan_status: "canceled",
      usage: usageAtCap,
    });

    const res = await handleContext(
      new Request("http://localhost/v1/context", {
        method: "POST",
        headers: {
          authorization: "Bearer mn_live_test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ user_id: "u1", query: "hello" }),
      }),
      makeEnv() as Record<string, unknown>,
      supabase as SupabaseClient,
      {},
    );

    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error.code).toBe("CAP_EXCEEDED");
    expect(json.error.upgrade_required).toBe(true);
    expect(json.error.effective_plan).toBe("free");
  });
});

describe("billing endpoint auth", () => {
  it("checkout requires API key", async () => {
    await expect(
      handleBillingCheckout(
        new Request("http://localhost/v1/billing/checkout", { method: "POST" }),
        makeEnv() as Record<string, unknown>,
        makeSupabase() as SupabaseClient,
        {},
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("portal requires API key", async () => {
    await expect(
      handleBillingPortal(
        new Request("http://localhost/v1/billing/portal", { method: "POST" }),
        makeEnv() as Record<string, unknown>,
        makeSupabase() as SupabaseClient,
        {},
      ),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });

  it("webhook skips API auth but enforces signature", async () => {
    const res = await handleBillingWebhook(
      new Request("http://localhost/v1/billing/webhook", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      makeEnv() as Record<string, unknown>,
      makeSupabase(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("BAD_REQUEST");
  });
});

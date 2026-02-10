import { afterEach, describe, expect, it, vi } from "vitest";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const env = {
  RATE_LIMIT_DO: makeRateLimitDoStub(),
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "salt",
  MASTER_ADMIN_TOKEN: "",
  SUPABASE_MODE: "stub",
} as const;

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

function findRequestSummary(logSpy: ReturnType<typeof vi.spyOn>) {
  for (const call of logSpy.mock.calls) {
    const first = call[0];
    if (typeof first !== "string") continue;
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      if (parsed.event_name === "request_summary") return parsed;
    } catch {
      // ignore non-JSON logs
    }
  }
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request summary logging", () => {
  it("emits one structured summary for successful requests", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await api.fetch(new Request("http://localhost/healthz"), env as unknown as FetchEnv);
    expect(res.status).toBe(200);

    const summary = findRequestSummary(logSpy);
    expect(summary).toBeTruthy();
    expect(summary).toMatchObject({
      event_name: "request_summary",
      route: "/healthz",
      method: "GET",
      status: 200,
    });
    expect(summary?.request_id).toEqual(expect.any(String));
    expect(summary?.duration_ms).toEqual(expect.any(Number));
    expect((summary?.duration_ms as number) >= 0).toBe(true);
  });

  it("includes error_code and error_message for error responses", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await api.fetch(new Request("http://localhost/not-found"), env as unknown as FetchEnv);
    expect(res.status).toBe(404);

    const summary = findRequestSummary(logSpy);
    expect(summary).toBeTruthy();
    expect(summary).toMatchObject({
      event_name: "request_summary",
      route: "/not-found",
      method: "GET",
      status: 404,
      error_code: "NOT_FOUND",
      error_message: "Not found",
    });
  });
});

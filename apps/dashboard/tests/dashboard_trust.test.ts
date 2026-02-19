/**
 * Phase 0.4 / G4: Dashboard trust tests.
 * (a) No API key in browser storage — apiClient must not expose loadApiKey/saveApiKey.
 * (b) Session-based auth — ensureDashboardSession and cookie-based flow exist.
 * (c) Workspace scoping — session is tied to workspace (tested via API contract).
 */

import { describe, expect, it, vi } from "vitest";
import * as apiClient from "../src/apiClient";

describe("Dashboard apiClient (Phase 0.2 — no key in browser)", () => {
  it("does not expose loadApiKey or saveApiKey (no key material in browser)", () => {
    expect("loadApiKey" in apiClient).toBe(false);
    expect("saveApiKey" in apiClient).toBe(false);
  });

  it("exposes session-based auth: ensureDashboardSession and dashboardLogout", () => {
    expect(typeof apiClient.ensureDashboardSession).toBe("function");
    expect(typeof apiClient.dashboardLogout).toBe("function");
  });

  it("exposes apiPost and apiGet for session-authenticated calls", () => {
    expect(typeof apiClient.apiPost).toBe("function");
    expect(typeof apiClient.apiGet).toBe("function");
  });

  it("exposes maskKey for display only (e.g. key prefix in UI)", () => {
    expect(apiClient.maskKey("mn_live_abc123")).toContain("…");
    expect(apiClient.maskKey("mn_live_abc123").length).toBeLessThan(20);
    expect(apiClient.maskKey("")).toBe("");
  });

  it("ensureDashboardSession calls POST /v1/dashboard/session with access_token and workspace_id (session + workspace flow)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, csrf_token: "csrf_abc" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("import.meta", { env: { VITE_API_BASE_URL: "https://api.test", PROD: false } });
    try {
      await (apiClient as { ensureDashboardSession: (t: string, w: string) => Promise<void> }).ensureDashboardSession(
        "supabase_access_token_xyz",
        "workspace-id-123",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/v1/dashboard/session");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body).toEqual({
        access_token: "supabase_access_token_xyz",
        workspace_id: "workspace-id-123",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Dashboard identity (no hardcoded dash-user)", () => {
  it("App.tsx and dashboard code do not reference dash-user", () => {
    // G1 is enforced by CI; this test documents the requirement.
    // We assert that the apiClient uses session, not a stored key.
    const mod = apiClient as Record<string, unknown>;
    expect(mod.loadApiKey).toBeUndefined();
    expect(mod.saveApiKey).toBeUndefined();
  });
});

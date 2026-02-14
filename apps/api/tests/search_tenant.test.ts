/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { performSearch } from "../src/index.js";
import { makeTestEnv } from "./helpers/env.js";

const uniqueText = "tenant-leak-zzz";

/** Custom Supabase mock that returns data only for workspace "wsA". */
function makeSupabase() {
  return {
    rpc(name: string, args: Record<string, any>) {
      if (name === "match_chunks_vector" || name === "match_chunks_text") {
        if (args.p_workspace_id === "wsA") {
          return Promise.resolve({
            data: [
              {
                chunk_id: "c1",
                memory_id: "memA",
                chunk_index: 0,
                chunk_text: uniqueText,
                score: 1,
              },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "bump_usage_rpc" || name === "bump_usage") {
        return Promise.resolve({
          data: { workspace_id: args.p_workspace_id, day: args.p_day, writes: 0, reads: 0, embeds: 0 },
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    },
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      if (table === "usage_daily") {
        return builder;
      }
      return builder;
    },
  };
}

const envStub = makeTestEnv();

describe("cross-tenant isolation for search/context", () => {
  it("search does not leak between workspaces", async () => {
    const supabase = makeSupabase();
    const authB = { workspaceId: "wsB", keyHash: "k", plan: "free" } as const;
    const res = await performSearch(
      authB,
      { user_id: "userB", namespace: "default", query: "tenant-leak", top_k: 5 },
      envStub as any,
      supabase as any,
    );
    expect(res.results.length).toBe(0);
  });

  it("context does not leak between workspaces", async () => {
    const supabase = makeSupabase();
    const authB = { workspaceId: "wsB", keyHash: "k", plan: "free" } as const;
    const res = await performSearch(
      authB,
      { user_id: "userB", namespace: "default", query: "tenant-leak", top_k: 5 },
      envStub as any,
      supabase as any,
    );
    expect(res.results.some((r) => r.text.includes(uniqueText) || r.memory_id === "memA")).toBe(false);
  });
});

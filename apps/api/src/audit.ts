/**
 * Request audit logging. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";
import { logger } from "./logger.js";

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function emitAuditLog(
  request: Request,
  response: Response | null,
  started: number,
  ip: string,
  env: Env,
  supabase: SupabaseClient | null,
  ctx: { workspaceId?: string; apiKeyId?: string },
  requestId: string,
): Promise<void> {
  try {
    const latency = Date.now() - started;
    const origin = request.headers.get("origin") ?? "";
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    const route = new URL(request.url).pathname;
    const ipHash = await hashIp(ip + (env.AUDIT_IP_SALT ?? ""));
    const bytesOut = Number(response?.headers.get("content-length") ?? "0");
    const status = response?.status ?? 0;
    const record = {
      ts: new Date().toISOString(),
      route,
      method: request.method,
      origin,
      bytes_in: Number.isFinite(contentLength) ? contentLength : 0,
      bytes_out: Number.isFinite(bytesOut) ? bytesOut : 0,
      latency_ms: latency,
      workspace_id: ctx.workspaceId ?? null,
      api_key_id: ctx.apiKeyId ?? null,
      ip_hash: ipHash,
      status,
      user_agent: request.headers.get("user-agent") ?? null,
      request_id: requestId,
    };
    logger.info({
      event: "audit_log",
      request_id: requestId,
      audit: record,
    });
    if (supabase) {
      await supabase.from("api_audit_log").insert({
        workspace_id: record.workspace_id,
        api_key_id: record.api_key_id,
        route: record.route,
        method: record.method,
        status: record.status,
        bytes_in: record.bytes_in,
        bytes_out: record.bytes_out,
        latency_ms: record.latency_ms,
        ip_hash: record.ip_hash,
        user_agent: record.user_agent,
      });
    }
  } catch (err) {
    logger.error({
      event: "audit_log_failed",
      request_id: requestId,
      route: new URL(request.url).pathname,
      method: request.method,
      err,
    });
  }
}

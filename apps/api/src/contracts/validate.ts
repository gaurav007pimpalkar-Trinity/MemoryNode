/**
 * Parse request body with Zod schema. Phase 5 (Option A: Zod as source of truth).
 * Returns same shape as safeParseJson for drop-in use in handlers.
 */

import type { z } from "zod";

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: Record<string, string[]> };

/**
 * Parse JSON body and validate with schema. On failure returns a single message
 * and optional details (Zod flatten) for 400 responses.
 */
export async function parseWithSchema<T extends z.ZodType>(
  schema: T,
  request: Request,
): Promise<ParseResult<z.infer<T>>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data as z.infer<T> };
  }
  const flat = result.error.flatten();
  const message = result.error.errors.length > 0
    ? result.error.errors.map((e) => e.message).join("; ")
    : "Validation failed";
  const details: Record<string, string[]> = {
    ...(flat.formErrors?.length ? { _form: flat.formErrors } : {}),
    ...Object.fromEntries(
      (Object.entries(flat.fieldErrors).filter((entry) =>
        Array.isArray(entry[1]) && (entry[1] as string[]).length > 0,
      ) as [string, string[]][]),
    ),
  };
  return {
    ok: false,
    error: message,
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

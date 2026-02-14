/**
 * HTTP error and response helpers. Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 */

export interface ApiError {
  code: string;
  message: string;
  status?: number;
  headers?: Record<string, string>;
}

export function createHttpError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): ApiError & Error {
  const err = new Error(message) as ApiError & Error;
  err.code = code;
  err.status = status;
  err.message = message;
  err.headers = headers;
  return err;
}

export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

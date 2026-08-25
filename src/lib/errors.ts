/**
 * Structured API error. Throw this in route handlers and lib helpers.
 * Route handlers must catch it and call toErrorResponse().
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Convert any thrown value into a JSON Response.
 * ApiError → its status + message.
 * Unknown errors → 500 (message suppressed to avoid leaking internals).
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("[Nightingale] Unhandled error:", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

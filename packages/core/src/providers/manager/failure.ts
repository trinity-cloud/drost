export type ProviderFailureClass =
  | "auth"
  | "permission"
  | "rate_limit"
  | "server_error"
  | "network"
  | "timeout"
  | "fatal_request"
  | "unknown";

function statusFromError(error: unknown): number | null {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusCode?: unknown };
  };

  const direct =
    typeof value.status === "number"
      ? value.status
      : typeof value.statusCode === "number"
        ? value.statusCode
        : null;
  if (direct !== null && Number.isFinite(direct)) {
    return Math.floor(direct);
  }

  const responseStatus =
    typeof value.response?.status === "number"
      ? value.response.status
      : typeof value.response?.statusCode === "number"
        ? value.response.statusCode
        : null;
  if (responseStatus !== null && Number.isFinite(responseStatus)) {
    return Math.floor(responseStatus);
  }
  return null;
}

export function classifyProviderFailure(error: unknown): ProviderFailureClass {
  const status = statusFromError(error);
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return "permission";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status !== null && status >= 500) {
    return "server_error";
  }
  if (status !== null && [400, 404, 409, 422].includes(status)) {
    return "fatal_request";
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) {
    return "timeout";
  }
  if (
    message.includes("econn") ||
    message.includes("network") ||
    message.includes("enotfound") ||
    message.includes("ehostunreach")
  ) {
    return "network";
  }
  if (
    message.includes("validation") ||
    message.includes("invalid request") ||
    message.includes("malformed") ||
    message.includes("bad request")
  ) {
    return "fatal_request";
  }

  return "unknown";
}

const ROUTE_RECOVERY_STORAGE_PREFIX = "adsecute-route-recovery";

const RECOVERABLE_ROUTE_ERROR_PATTERNS = [
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /Loading CSS chunk \d+ failed/i,
  /failed to fetch dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /module script load request failed/i,
  /script error/i,
  /__webpack_require__\.e/i,
  /RSC payload/i,
  /fetch server response failed/i,
];

export function routeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, error.stack].filter(Boolean).join("\n");
  }
  if (typeof error === "object" && error) {
    const record = error as { name?: unknown; message?: unknown; stack?: unknown; reason?: unknown };
    return [record.name, record.message, record.stack, record.reason]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }
  return typeof error === "string" ? error : "";
}

export function isRecoverableRouteLoadError(error: unknown): boolean {
  const message = routeErrorMessage(error);
  if (!message) return false;
  return RECOVERABLE_ROUTE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function hashSignature(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function recoveryKey(scope: string, error: unknown) {
  const path =
    typeof window === "undefined"
      ? "server"
      : `${window.location.pathname}${window.location.search}`;
  const signature = routeErrorMessage(error).slice(0, 240) || "unknown";
  return `${ROUTE_RECOVERY_STORAGE_PREFIX}:${scope}:${path}:${hashSignature(signature)}`;
}

export function markRouteRecoveryAttempted(scope: string, error: unknown) {
  if (typeof window === "undefined") return false;
  const key = recoveryKey(scope, error);
  try {
    if (window.sessionStorage.getItem(key) === "1") return false;
    window.sessionStorage.setItem(key, "1");
    return true;
  } catch {
    const globalKey = `__${key}`;
    const recoveries = window as unknown as Record<string, unknown>;
    if (recoveries[globalKey]) return false;
    recoveries[globalKey] = true;
    return true;
  }
}

export function recoverRouteLoadOnce(error: unknown, scope = "route") {
  if (typeof window === "undefined") return false;
  if (!isRecoverableRouteLoadError(error)) return false;
  if (!markRouteRecoveryAttempted(scope, error)) return false;
  window.location.reload();
  return true;
}

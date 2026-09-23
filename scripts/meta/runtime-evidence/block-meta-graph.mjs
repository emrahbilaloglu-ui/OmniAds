import { appendFileSync } from "node:fs";

const attemptFile = process.env.META_RUNTIME_GRAPH_ATTEMPT_FILE?.trim();
const serverLabel = process.env.META_RUNTIME_SERVER_LABEL?.trim() || "unknown";
const originalFetch = globalThis.fetch;

if (typeof originalFetch !== "function") {
  throw new Error("Runtime evidence requires the Node fetch implementation.");
}

function resolveUrl(input) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input);
    }
    if (input && typeof input.url === "string") return new URL(input.url);
  } catch {
    return null;
  }
  return null;
}

function graphEdge(url) {
  const known = new Set([
    "insights",
    "campaigns",
    "adsets",
    "ads",
    "activities",
    "adimages",
    "oauth",
    "me",
  ]);
  const segments = url.pathname.split("/").filter(Boolean).reverse();
  return segments.find((segment) => known.has(segment)) ?? "other";
}

globalThis.fetch = async function runtimeEvidenceFetch(input, init) {
  const url = resolveUrl(input);
  if (
    url &&
    (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
  ) {
    const requestMethod =
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET");
    if (attemptFile) {
      // Deliberately omit path and query: provider ids and tokens do not belong
      // in a test artifact. The server, generic edge name and method are enough
      // to prove which forbidden boundary was reached.
      appendFileSync(
        attemptFile,
        `${new Date().toISOString()} ${serverLabel} ${graphEdge(url)} ${requestMethod}\n`,
        "utf8",
      );
    }
    throw new Error("Runtime evidence forbids Meta Graph network access.");
  }
  return Reflect.apply(originalFetch, globalThis, [input, init]);
};

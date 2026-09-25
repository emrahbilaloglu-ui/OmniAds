import type { NextRequest } from "next/server";

/** Resolve browser redirects against the configured public origin, not the container listener. */
export function publicRedirectBaseUrl(request: NextRequest): URL {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
        return url;
      }
    } catch {
      // An invalid optional setting cannot break local routing.
    }
  }
  return request.nextUrl;
}

import { QueryClient } from "@tanstack/react-query";

/**
 * Revalidation policy.
 *
 * Every revalidation trigger used to be off, so a tab left open through a sync
 * cycle kept serving the numbers it loaded hours earlier with nothing on screen
 * admitting their age. Budget and creative decisions were being made against
 * data that had silently stopped moving.
 *
 * Focus and reconnect revalidation are enabled and bounded by `staleTime`, so
 * returning to a tab refreshes at most once a minute per query rather than on
 * every window switch. `refetchOnMount` stays off: navigation already remounts
 * these surfaces constantly, and refetching there costs a round trip per hop
 * without telling the operator anything new.
 *
 * The plan requires this policy to be reversible by one documented runtime flag
 * if it ever causes a production incident. Setting
 * `NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION=1` restores the previous behaviour.
 * Stale-age disclosure on the surfaces themselves is not optional and does not
 * depend on this flag.
 */
export function isQueryRevalidationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NEXT_PUBLIC_DISABLE_QUERY_REVALIDATION?.trim() !== "1";
}

export const QUERY_STALE_TIME_MS = 60 * 1000;

function createQueryClient() {
  const revalidate = isQueryRevalidationEnabled();
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        refetchOnWindowFocus: revalidate,
        refetchOnReconnect: revalidate,
        refetchOnMount: false,
        retry: 1,
      },
    },
  });
}

let browserQueryClient: QueryClient | null = null;

export function getAppQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    return createQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = createQueryClient();
  }
  return browserQueryClient;
}

export function clearAppQueryClient() {
  if (typeof window === "undefined") return;
  browserQueryClient?.clear();
}

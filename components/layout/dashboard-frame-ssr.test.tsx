/**
 * The dashboard group has to carry its own QueryClient.
 *
 * On build 77a45acb6 every route in this group answered "Application error: a
 * client-side exception has occurred", and the server log named the cause:
 * `No QueryClient set, use QueryClientProvider to set one`. It was not the
 * pages — `/overview` and `/team` failed identically, and both logged
 * `decision=legacy` first, so the right body was chosen and the shell around it
 * threw.
 *
 * The root layout does wrap everything in `QueryProvider`, and in the
 * production build that context did not reach this subtree. Two things kept it
 * hidden: the proxy redirected these routes away before they could render, and
 * the canonical `/app` surface uses react-query zero times — so no page that
 * actually rendered in production exercised the root provider.
 *
 * The component tests each mount their own provider, which is why they all
 * passed while production did not. These render on the server, the way
 * production does, and the second one is the failure exactly.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryProvider } from "@/providers/query-provider";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { DashboardFrame } from "@/components/layout/dashboard-frame";

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** What `app/(dashboard)/layout.tsx` returns, minus the session lookup. */
function DashboardLayoutBody({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AuthBootstrap />
      <DashboardFrame userName="Test User">{children}</DashboardFrame>
    </QueryProvider>
  );
}

describe("the dashboard group on the server", () => {
  it("renders with no provider above it, because production has none that reaches here", () => {
    const markup = renderToStaticMarkup(
      <DashboardLayoutBody>
        <div>legacy body</div>
      </DashboardLayoutBody>,
    );

    expect(markup).toContain("adv-shell");
  });

  it("is the shell that needs it: without a provider the shell throws production's error", () => {
    expect(() =>
      renderToStaticMarkup(
        <DashboardFrame userName="Test User">
          <div>legacy body</div>
        </DashboardFrame>,
      ),
    ).toThrow(/No QueryClient set/);
  });

  it("still nests cleanly when a provider is inherited from above", () => {
    const markup = renderToStaticMarkup(
      <QueryProvider>
        <DashboardLayoutBody>
          <div>legacy body</div>
        </DashboardLayoutBody>
      </QueryProvider>,
    );

    expect(markup).toContain("adv-shell");
  });
});

import { redirect } from "next/navigation";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { DashboardFrame } from "@/components/layout/dashboard-frame";
import { getSessionFromCookies } from "@/lib/auth";
import { QueryProvider } from "@/providers/query-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let session;
  try {
    session = await getSessionFromCookies();
  } catch {
    redirect("/login");
  }
  if (!session) {
    redirect("/login");
  }

  // The shell itself queries -- the freshness bar, the notification bell -- so
  // the provider belongs here, in the same subtree, rather than being inherited
  // from the root layout. It was inherited until now, and in the production
  // build the context did not arrive: every route in this group answered
  // "Application error: a client-side exception has occurred", with
  // `No QueryClient set, use QueryClientProvider to set one` in the server log.
  //
  // Nothing caught it because these routes were redirected away at the proxy
  // before they could render, and the canonical `/app` surface does not use
  // react-query at all -- so no page that renders in production exercised the
  // root provider. `dashboard-frame-ssr.test.tsx` renders this composition on
  // the server with no outer provider, which is the shape that failed.
  //
  // Nesting under the root provider is harmless: the nearest one wins.
  return (
    <QueryProvider>
      <AuthBootstrap />
      <DashboardFrame userName={session.user.name}>{children}</DashboardFrame>
    </QueryProvider>
  );
}

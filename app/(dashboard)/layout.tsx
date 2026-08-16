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
  // the provider belongs in the same subtree rather than being inherited from
  // three levels up. It was inherited until now, and in the shipped image the
  // context did not arrive at all: the build bound the wrong module to the root
  // layout slot, so the layout holding `QueryProvider` never ran. Every route
  // here answered "Application error", with `No QueryClient set` in the server
  // log. The Dockerfile explains that build defect and fixes it.
  //
  // This stays anyway. A subtree that queries should own its client, and it
  // means one build-level surprise cannot take the whole group down again.
  // Nesting under the root provider is harmless: the nearest one wins.
  return (
    <QueryProvider>
      <AuthBootstrap />
      <DashboardFrame userName={session.user.name}>{children}</DashboardFrame>
    </QueryProvider>
  );
}

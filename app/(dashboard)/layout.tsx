import { redirect } from "next/navigation";
import { DesktopSidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { BusinessGuard } from "@/components/layout/business-guard";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { getSessionFromCookies } from "@/lib/auth";

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

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AuthBootstrap />
      {/* Desktop sidebar */}
      <DesktopSidebar />

      {/* Main content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <Topbar userName={session.user.name} />
        <main className="flex-1 overflow-y-auto bg-neutral-50 p-6">
          <BusinessGuard>{children}</BusinessGuard>
        </main>
      </div>
    </div>
  );
}

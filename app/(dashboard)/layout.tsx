import { redirect } from "next/navigation";
import { AuthBootstrap } from "@/components/layout/auth-bootstrap";
import { DashboardFrame } from "@/components/layout/dashboard-frame";
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
    <>
      <AuthBootstrap />
      <DashboardFrame userName={session.user.name}>{children}</DashboardFrame>
    </>
  );
}

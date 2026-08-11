import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { readAgencyDirectorySource } from "@/lib/zero-base/agency-directory-server";
import { ClientDirectory } from "@/components/zero-base/agency/client-directory";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";

export const dynamic = "force-dynamic";

export default async function AgencyClientsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSessionFromCookies();
  if (!session) redirect(loginUrlFor("/a/desk/clients"));

  const params = (await searchParams) ?? {};
  const single = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;

  const businesses = await readAgencyDirectorySource({
    userId: session.user.id,
    email: session.user.email,
  });

  return (
    <>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: "0 0 16px" }}>
        Clients
      </h2>
      <ClientDirectory
        businesses={businesses}
        returnPath="/a/desk/clients"
        initialQuery={single(params.q) ?? ""}
        initialCursor={single(params.cursor)}
      />
    </>
  );
}

import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import {
  InvalidAgencyCursorError,
  readAgencyDirectoryPage,
} from "@/lib/zero-base/agency-directory-store";
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

  const cursor = single(params.cursor);
  // A tampered cursor restarts at the first page rather than erroring the
  // whole surface: the operator gets a usable directory, and the boundary
  // still refuses the bad value.
  const page = await readAgencyDirectoryPage({
    userId: session.user.id,
    email: session.user.email,
    cursor,
    withTotal: true,
  }).catch(async (error: unknown) => {
    if (error instanceof InvalidAgencyCursorError) {
      return readAgencyDirectoryPage({
        userId: session.user.id,
        email: session.user.email,
        withTotal: true,
      });
    }
    throw error;
  });

  return (
    <>
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: "0 0 16px" }}>
        Clients
      </h2>
      <ClientDirectory
        initialPage={page}
        returnPath="/a/desk/clients"
        initialQuery={single(params.q) ?? ""}
        restoredCursor={cursor}
      />
    </>
  );
}

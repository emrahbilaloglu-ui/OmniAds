import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import {
  decodeAgencyCursor,
  readAgencyDirectoryPage,
} from "@/lib/zero-base/agency-directory-store";
import { ClientDirectory } from "@/components/zero-base/agency/client-directory";
import { InvalidCursorState } from "@/components/zero-base/agency/invalid-cursor-state";
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

  // Validated before anything is read.
  //
  // The earlier version caught the store's error and quietly served page one,
  // then handed the rejected cursor back to the client as `restoredCursor` —
  // so every row on that page advertised a return the API boundary would 400.
  // A bad cursor now costs no query and reaches no return link: the page says
  // what happened and offers one clean way out.
  if (cursor !== null && decodeAgencyCursor(cursor) === null) {
    return <InvalidCursorState returnPath="/a/desk/clients" />;
  }

  const page = await readAgencyDirectoryPage({
    userId: session.user.id,
    email: session.user.email,
    cursor,
    withTotal: true,
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

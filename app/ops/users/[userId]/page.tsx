import AdminUserDetail from "@/app/admin/users/[userId]/legacy-page";

export const dynamic = "force-dynamic";

/**
 * Canonical Ops mirror of /admin/users/[userId].
 *
 * The admin component is mounted as-is, so confirmation, progress, error and
 * read-back semantics are literally the same code. Only the surrounding shell
 * differs; adapting composition without duplicating operational logic is the
 * point of this work package.
 */
export default function Page() {
  return <AdminUserDetail />;
}

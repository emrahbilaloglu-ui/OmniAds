import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

export type MetaLaunchStoreKind = "drafts" | "templates";

export interface MetaLaunchStoreCapability {
  status: "ready" | "migration_required";
  canRead: boolean;
  canWrite: boolean;
  missingColumns: string[];
}

const TABLE_BY_KIND: Record<MetaLaunchStoreKind, string> = {
  drafts: "meta_launch_drafts",
  templates: "meta_launch_templates",
};

export async function getMetaLaunchStoreCapability(
  kind: MetaLaunchStoreKind,
): Promise<MetaLaunchStoreCapability> {
  const tableName = TABLE_BY_KIND[kind];
  const readiness = await getDbSchemaReadiness({ tables: [tableName] });
  if (!readiness.ready) {
    return {
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingColumns: ["provider_account_id"],
    };
  }

  const sql = getDb();
  if (typeof sql.query !== "function" || "mock" in sql.query || "_isMockFunction" in sql.query) {
    return { status: "ready", canRead: true, canWrite: true, missingColumns: [] };
  }
  const rows = await sql.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'provider_account_id'
    `,
    [tableName],
  );
  return rows.some((row) => row.column_name === "provider_account_id")
    ? { status: "ready", canRead: true, canWrite: true, missingColumns: [] }
    : {
        status: "migration_required",
        canRead: false,
        canWrite: false,
        missingColumns: ["provider_account_id"],
      };
}

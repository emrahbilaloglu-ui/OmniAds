/**
 * PRE-DEPLOY AUDIT — the D088 schema postcondition, driven against a catalog.
 *
 * The real seam (`scripts/d088-budget-proposal-migration-seam.ts`) runs this
 * verifier against a REAL PostgreSQL that the real migration registry built,
 * which is the only thing that proves the positive case. What it cannot do is
 * prove the NEGATIVE cases: to see the verifier refuse a missing column, a
 * wrong type, a constraint sitting on the wrong table or a missing index, you
 * would have to damage a live cluster in eleven different ways.
 *
 * So the negatives are driven here, against a synthetic `information_schema` /
 * `pg_catalog` built to match what the real migration produces. Each case
 * takes that healthy catalog and breaks exactly one thing — the discipline
 * that makes each assertion about ONE defect rather than about a soup of them.
 *
 * The healthy fixture is not decoration either: `it("accepts the healthy
 * catalog")` is what stops a verifier that refuses everything from passing
 * every negative case for the wrong reason.
 */
import { describe, expect, it } from "vitest";

import {
  D088_JOURNAL_COLUMN_CONTRACT,
  D088_JOURNAL_INDEX_CONTRACT,
  D088BudgetSchemaError,
  assertD088BudgetSchema,
} from "@/lib/meta/budget-schema-verification";

interface CatalogColumn {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  character_maximum_length: number | null;
}

interface Catalog {
  activation: Array<{ data_type: string; is_nullable: string; column_default: string | null }>;
  master: Array<{ is_nullable: string; column_default: string | null }>;
  envelopeColumn: number;
  constraints: Array<{ conname: string; relname: string; def: string }>;
  journalColumns: CatalogColumn[];
  indexes: Array<{ indexname: string; indexdef: string }>;
  legacyUnique: number;
}

/** Exactly what `lib/migrations.ts` builds when every statement succeeds. */
function healthyCatalog(): Catalog {
  return {
    activation: [{ data_type: "text", is_nullable: "YES", column_default: null }],
    master: [{ is_nullable: "NO", column_default: "false" }],
    envelopeColumn: 1,
    constraints: [
      {
        conname: "meta_automation_proposals_action_budget_check",
        relname: "meta_automation_proposals",
        def: "CHECK (proposed_action = ANY (ARRAY['pause'::text, 'resume'::text, 'bid'::text, 'duplicate'::text, 'budget'::text]))",
      },
      {
        conname: "meta_automation_proposals_budget_envelope_check",
        relname: "meta_automation_proposals",
        def: "CHECK (proposed_action <> 'budget'::text OR budget_envelope_json IS NOT NULL)",
      },
      {
        conname: "meta_budget_write_journal_rollback_check",
        relname: "meta_budget_write_journal",
        def: "CHECK (rollback_eligible = false OR (result_class = 'verified'::text AND before_amount_minor IS NOT NULL))",
      },
    ],
    journalColumns: D088_JOURNAL_COLUMN_CONTRACT.map((column) => ({
      column_name: column.name,
      data_type: column.type,
      is_nullable: column.nullable ? "YES" : "NO",
      column_default:
        "defaultContains" in column
          ? ({
            "gen_random_uuid": "gen_random_uuid()",
            "false": "false",
            "[]": "'[]'::jsonb",
            "now()": "now()",
          }[column.defaultContains as string] ?? null)
          : null,
      character_maximum_length: "maxLength" in column ? (column.maxLength as number) : null,
    })),
    indexes: [
      {
        indexname: "meta_budget_write_journal_occurrence",
        indexdef:
          "CREATE UNIQUE INDEX meta_budget_write_journal_occurrence ON public.meta_budget_write_journal USING btree (business_id, provider_account_id, idempotency_key)",
      },
      {
        indexname: "idx_meta_budget_write_journal_entity",
        indexdef:
          "CREATE INDEX idx_meta_budget_write_journal_entity ON public.meta_budget_write_journal USING btree (business_id, provider_account_id, owner_grain, entity_id, requested_at DESC, id DESC)",
      },
    ],
    legacyUnique: 1,
  };
}

/** Answer the verifier's queries from a catalog, dispatching on the SQL text. */
function sqlFor(catalog: Catalog) {
  return {
    query: async (text: string): Promise<unknown> => {
      const sql = text.replace(/\s+/g, " ");
      if (sql.includes("auto_execution_provider_account_id")) return catalog.activation;
      if (sql.includes("'auto_execution_enabled'")) return catalog.master;
      if (sql.includes("'budget_envelope_json'")) return [{ n: String(catalog.envelopeColumn) }];
      if (sql.includes("pg_get_constraintdef(c.oid) AS def") && sql.includes("c.contype = 'c'")) {
        return catalog.constraints;
      }
      if (sql.includes("'meta_budget_write_journal'") && sql.includes("character_maximum_length")) {
        return catalog.journalColumns;
      }
      if (sql.includes("pg_indexes")) return catalog.indexes;
      if (sql.includes("engine_v3_campaign_context_daily")) {
        return Array.from({ length: catalog.legacyUnique }, () => ({
          def: "UNIQUE (business_id, campaign_id, as_of_date)",
        }));
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 120)}`);
    },
  } as unknown as Parameters<typeof assertD088BudgetSchema>[0];
}

async function failuresFor(mutate: (catalog: Catalog) => void): Promise<string[]> {
  const catalog = healthyCatalog();
  mutate(catalog);
  try {
    await assertD088BudgetSchema(sqlFor(catalog));
  } catch (error) {
    if (error instanceof D088BudgetSchemaError) return error.failures;
    throw error;
  }
  return [];
}

describe("D088 schema verification — the positive case", () => {
  it("accepts the healthy catalog, so every refusal below means something", async () => {
    const result = await assertD088BudgetSchema(sqlFor(healthyCatalog()));
    expect(result.contract).toBe("meta.d088-budget-schema-verification.v2");
    expect(result.verified.length).toBeGreaterThan(8);
  });

  it("declares the whole 26-column journal contract", () => {
    // The count is pinned so a column removed from the contract is a visible
    // edit rather than a quiet reduction in what the postcondition covers.
    expect(D088_JOURNAL_COLUMN_CONTRACT).toHaveLength(26);
    expect(new Set(D088_JOURNAL_COLUMN_CONTRACT.map((c) => c.name)).size).toBe(26);
    expect(D088_JOURNAL_INDEX_CONTRACT).toHaveLength(2);
  });
});

describe("D088 schema verification — a MISSING column", () => {
  it.each(D088_JOURNAL_COLUMN_CONTRACT.map((column) => column.name))(
    "refuses when meta_budget_write_journal.%s is absent",
    async (name) => {
      const failures = await failuresFor((catalog) => {
        catalog.journalColumns = catalog.journalColumns.filter((c) => c.column_name !== name);
      });
      expect(failures).toContain(`meta_budget_write_journal.${name} is absent`);
    },
  );

  it("refuses when the whole table is absent", async () => {
    const failures = await failuresFor((catalog) => { catalog.journalColumns = []; });
    expect(failures).toContain("meta_budget_write_journal is absent");
  });
});

describe("D088 schema verification — a WRONG column", () => {
  it("refuses a wrong data type", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === "currency_exponent")!.data_type = "text";
    });
    expect(failures).toContain(
      "meta_budget_write_journal.currency_exponent is text, not smallint",
    );
  });

  it("refuses a NOT NULL where the contract needs nullable", async () => {
    /*
      The exact defect that would break every unknown-before write: with
      `before_amount_minor` NOT NULL the runtime cannot record "the provider
      would not tell us what it was", and the only way to insert becomes a
      fabricated number.
    */
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === "before_amount_minor")!.is_nullable = "NO";
    });
    expect(failures).toContain(
      "meta_budget_write_journal.before_amount_minor is NOT NULL, expected nullable",
    );
  });

  it("refuses a nullable where the contract needs NOT NULL", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === "intended_amount_minor")!.is_nullable = "YES";
    });
    expect(failures).toContain(
      "meta_budget_write_journal.intended_amount_minor is nullable, expected NOT NULL",
    );
  });

  it("refuses a wrong fixed width on the request fingerprint", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === "request_fingerprint")!
        .character_maximum_length = 32;
    });
    expect(failures).toContain("meta_budget_write_journal.request_fingerprint width is 32, expected 64");
  });

  it.each([
    ["provider_attempted", "false"],
    ["rollback_eligible", "false"],
    ["blockers_json", "[]"],
    ["created_at", "now()"],
    ["id", "gen_random_uuid"],
  ])("refuses a missing safety default on %s", async (name, fragment) => {
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === name)!.column_default = null;
    });
    expect(failures.join(" | ")).toContain(
      `meta_budget_write_journal.${name} default is absent, expected one containing ${fragment}`,
    );
  });

  it("refuses a safety default flipped to TRUE", async () => {
    // `rollback_eligible DEFAULT true` would mark every omitted-column insert
    // as restorable, including the ones that recorded nothing to restore.
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns.find((c) => c.column_name === "rollback_eligible")!.column_default = "true";
    });
    expect(failures.join(" | ")).toContain("meta_budget_write_journal.rollback_eligible default is true");
  });
});

describe("D088 schema verification — a constraint on the WRONG table or schema", () => {
  /*
    THE COLLISION THE PREVIOUS VERSION COULD NOT SEE.

    It asked `SELECT count(*) FROM pg_constraint WHERE conname = '…'` with no
    schema and no table. A constraint of that name anywhere in the database
    answered yes — a restored scratch table, a second schema on the same
    cluster, an old copy left by a cutover. These cases reproduce exactly that
    shape: the name exists, on the wrong relation, and the verifier must still
    refuse.
  */
  it.each([
    ["meta_automation_proposals_budget_envelope_check", "meta_automation_proposals"],
    ["meta_automation_proposals_action_budget_check", "meta_automation_proposals"],
    ["meta_budget_write_journal_rollback_check", "meta_budget_write_journal"],
  ])("refuses %s when it sits on another table", async (name, table) => {
    const failures = await failuresFor((catalog) => {
      catalog.constraints.find((c) => c.conname === name)!.relname = "scratch_restore_copy";
    });
    expect(failures.join(" | ")).toContain(`${name} is absent from ${table}`);
    // And it says WHERE the impostor is, so the operator can go delete it.
    expect(failures.join(" | ")).toContain("a same-named constraint exists on scratch_restore_copy");
  });

  it("refuses when a constraint is missing outright", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.constraints = catalog.constraints.filter(
        (c) => c.conname !== "meta_budget_write_journal_rollback_check",
      );
    });
    expect(failures.join(" | ")).toContain(
      "meta_budget_write_journal_rollback_check is absent from meta_budget_write_journal",
    );
    expect(failures.join(" | ")).not.toContain("a same-named constraint exists");
  });

  it("refuses an action constraint that does not admit budget", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.constraints.find(
        (c) => c.conname === "meta_automation_proposals_action_budget_check",
      )!.def = "CHECK (proposed_action = ANY (ARRAY['pause'::text, 'resume'::text, 'bid'::text, 'duplicate'::text]))";
    });
    expect(failures.join(" | ")).toContain("does not constrain 'budget'");
  });

  it("refuses a narrow legacy action constraint still standing beside the widened one", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.constraints.push({
        conname: "meta_automation_proposals_action_check",
        relname: "meta_automation_proposals",
        def: "CHECK (proposed_action = ANY (ARRAY['pause'::text, 'duplicate'::text]))",
      });
    });
    expect(failures.join(" | ")).toContain("a narrow legacy action constraint still stands");
  });
});

describe("D088 schema verification — MISSING or WRONG indexes", () => {
  it.each(D088_JOURNAL_INDEX_CONTRACT.map((index) => index.name))(
    "refuses when %s is absent",
    async (name) => {
      const failures = await failuresFor((catalog) => {
        catalog.indexes = catalog.indexes.filter((index) => index.indexname !== name);
      });
      expect(failures.join(" | ")).toContain(`${name} is absent`);
    },
  );

  it("refuses an occurrence index that is not UNIQUE", async () => {
    // Not unique means the database stops enforcing idempotency, and the
    // orchestrator's concurrent-race safety becomes a comment.
    const failures = await failuresFor((catalog) => {
      const index = catalog.indexes.find(
        (i) => i.indexname === "meta_budget_write_journal_occurrence",
      )!;
      index.indexdef = index.indexdef.replace("CREATE UNIQUE INDEX", "CREATE INDEX");
    });
    expect(failures.join(" | ")).toContain(
      "meta_budget_write_journal_occurrence is not UNIQUE, expected UNIQUE",
    );
  });

  it("refuses an occurrence index over the wrong columns", async () => {
    const failures = await failuresFor((catalog) => {
      const index = catalog.indexes.find(
        (i) => i.indexname === "meta_budget_write_journal_occurrence",
      )!;
      index.indexdef = index.indexdef.replace(
        "(business_id, provider_account_id, idempotency_key)",
        "(business_id, idempotency_key)",
      );
    });
    expect(failures.join(" | ")).toContain("meta_budget_write_journal_occurrence columns are");
  });

  it("refuses an entity index whose column ORDER differs", async () => {
    /*
      Order is not cosmetic. `(entity_id, business_id, …)` cannot serve the
      business-scoped prefix the readiness read issues, and dropping the
      trailing `requested_at DESC, id DESC` turns "latest per entity" from an
      index lookup back into the scan this index was added to remove.
    */
    const failures = await failuresFor((catalog) => {
      const index = catalog.indexes.find(
        (i) => i.indexname === "idx_meta_budget_write_journal_entity",
      )!;
      index.indexdef = index.indexdef.replace(
        "(business_id, provider_account_id, owner_grain, entity_id, requested_at DESC, id DESC)",
        "(business_id, provider_account_id, owner_grain, entity_id, id DESC, requested_at DESC)",
      );
    });
    expect(failures.join(" | ")).toContain("idx_meta_budget_write_journal_entity columns are");
  });

  it("refuses an entity index that lost its DESC ordering", async () => {
    const failures = await failuresFor((catalog) => {
      const index = catalog.indexes.find(
        (i) => i.indexname === "idx_meta_budget_write_journal_entity",
      )!;
      index.indexdef = index.indexdef.replace("requested_at DESC, id DESC", "requested_at, id");
    });
    expect(failures.join(" | ")).toContain("idx_meta_budget_write_journal_entity columns are");
  });
});

describe("D088 schema verification — the activation column, exactly", () => {
  it("refuses an absent activation column", async () => {
    const failures = await failuresFor((catalog) => { catalog.activation = []; });
    expect(failures).toContain(
      "meta_automation_business_controls.auto_execution_provider_account_id is absent",
    );
  });

  it("refuses a wrong type", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.activation[0]!.data_type = "uuid";
    });
    expect(failures).toContain("auto_execution_provider_account_id is uuid, not text");
  });

  it("refuses NOT NULL: unactivated is unknown, and unknown needs a null", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.activation[0]!.is_nullable = "NO";
    });
    expect(failures).toContain(
      "auto_execution_provider_account_id must be nullable: unactivated is unknown",
    );
  });

  it("refuses ANY default — a default would bind an account nobody chose", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.activation[0]!.column_default = "'act_123'::text";
    });
    expect(failures.join(" | ")).toContain(
      "auto_execution_provider_account_id must have no default",
    );
  });

  it("refuses a master switch that is nullable or defaults ON", async () => {
    expect(await failuresFor((catalog) => { catalog.master[0]!.is_nullable = "YES"; }))
      .toContain("auto_execution_enabled must be NOT NULL");
    expect((await failuresFor((catalog) => { catalog.master[0]!.column_default = "true"; })).join(" | "))
      .toContain("auto_execution_enabled default is true, not false");
  });
});

describe("D088 schema verification — rollback compatibility", () => {
  it("refuses when the legacy campaign-context unique is gone", async () => {
    const failures = await failuresFor((catalog) => { catalog.legacyUnique = 0; });
    expect(failures.join(" | ")).toContain(
      "engine_v3_campaign_context_daily lost UNIQUE (business_id, campaign_id, as_of_date)",
    );
  });
});

describe("D088 schema verification — it reports EVERY defect, not the first", () => {
  it("collects independent failures together", async () => {
    const failures = await failuresFor((catalog) => {
      catalog.journalColumns = catalog.journalColumns.filter(
        (c) => c.column_name !== "currency_exponent",
      );
      catalog.indexes = catalog.indexes.filter(
        (i) => i.indexname !== "idx_meta_budget_write_journal_entity",
      );
      catalog.activation[0]!.is_nullable = "NO";
    });
    expect(failures.length).toBeGreaterThanOrEqual(3);
    expect(failures.join(" | ")).toContain("currency_exponent is absent");
    expect(failures.join(" | ")).toContain("idx_meta_budget_write_journal_entity is absent");
    expect(failures.join(" | ")).toContain("must be nullable");
  });
});

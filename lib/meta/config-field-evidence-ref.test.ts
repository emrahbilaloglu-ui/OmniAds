/**
 * The receipt reference a config verdict cites, and the rule that refuses one.
 *
 * The rule is stated once (`identityCoherent` / `configFieldEvidenceRefCoherentSql`)
 * and a refused reference makes its field grant nothing, so both directions
 * matter: a legitimate reference the producer emits must pass, and every
 * malformed or self-contradicting one must fail. The SQL twin is executed on
 * real PostgreSQL over these same fixtures in config-field-evidence-ref.db.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  configFieldEvidenceRefCoherentSql,
  configFieldEvidenceRefIdentityText,
  configReceiptManifestLine,
  hashConfigReceiptManifest,
  parseConfigFieldEvidenceRef,
  parseConfigReceiptWindowManifest,
} from "@/lib/meta/config-field-evidence-ref";
import { COHERENCE_FIXTURES, receiptRef } from "@/lib/meta/config-field-evidence-ref.fixtures";

describe("parseConfigFieldEvidenceRef", () => {
  it.each(COHERENCE_FIXTURES)("$name -> $coherent", ({ ref, field, coherent }) => {
    expect(parseConfigFieldEvidenceRef(ref, field).ok).toBe(coherent);
  });

  it("returns the reference enumerated, readiness recomputed from the tier", () => {
    const parsed = parseConfigFieldEvidenceRef(receiptRef(), "objective");
    expect(parsed.ok && parsed.ref).toMatchObject({
      field: "objective",
      tier: "provider_receipt_day_bracketed",
      readiness: "decision_authority",
      observationId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("names why a reference was refused", () => {
    expect(parseConfigFieldEvidenceRef(null, "objective")).toEqual({ ok: false, refusal: "absent" });
    expect(parseConfigFieldEvidenceRef(receiptRef(), "optimization_goal")).toEqual({
      ok: false,
      refusal: "field_mismatch",
    });
    expect(
      parseConfigFieldEvidenceRef({ ...receiptRef(), readiness: "none" }, "objective"),
    ).toEqual({ ok: false, refusal: "readiness_incoherent" });
  });
});

describe("the SQL twin is generated from the same rule", () => {
  it("is total: wrapped so a NULL reference reads FALSE, never NULL", () => {
    const sql = configFieldEvidenceRefCoherentSql("refs.objective_ref", "objective");
    expect(sql.startsWith("COALESCE((")).toBe(true);
    expect(sql.trimEnd().endsWith("), FALSE)")).toBe(true);
  });

  it("refuses an expression it did not generate", () => {
    expect(() => configFieldEvidenceRefCoherentSql("x; DROP TABLE y", "objective")).toThrow(
      "config_evidence_ref_sql_expression_invalid",
    );
  });
});

describe("the economic-window manifest", () => {
  it("moves when one observation under the same snapshot changes, and only then", () => {
    const line = (observationId: string) =>
      configReceiptManifestLine("2026-09-20", {
        objective: { ...receiptRef(), observationId },
      });
    const a = hashConfigReceiptManifest([line("33333333-3333-4333-8333-333333333333")]);
    const b = hashConfigReceiptManifest([line("44444444-4444-4444-8444-444444444444")]);
    const again = hashConfigReceiptManifest([line("33333333-3333-4333-8333-333333333333")]);
    expect(a).not.toBe(b);
    expect(a).toBe(again);
  });

  it("binds reference and normalization contracts into the manifest identity", () => {
    const base = receiptRef();
    const identity = configFieldEvidenceRefIdentityText(base);
    expect(configFieldEvidenceRefIdentityText({ ...base, refContractVersion: "v0" }))
      .not.toBe(identity);
    expect(configFieldEvidenceRefIdentityText({ ...base, sourceContractVersion: "source.v0" }))
      .not.toBe(identity);
    expect(configFieldEvidenceRefIdentityText({ ...base, normalizationVersion: 2 }))
      .not.toBe(identity);
  });

  it("writes an absent reference as 'absent', never as an empty identity", () => {
    expect(configFieldEvidenceRefIdentityText(null)).toBe("absent");
    expect(configReceiptManifestLine("2026-09-20", {})).toBe(
      "2026-09-20|absent|absent|absent|absent",
    );
  });

  it("refuses a malformed manifest instead of trusting it", () => {
    const good = { hash: "c".repeat(64), economicDayCount: 3, nullObservationIdCount: 0, incoherentDayCount: 0 };
    expect(parseConfigReceiptWindowManifest(good)).not.toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, hash: "nope" })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, economicDayCount: -1 })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, incoherentDayCount: 1.5 })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, incoherentDayCount: 4 })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, nullObservationIdCount: 13 })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, manifestVersion: "v0" })).toBeNull();
    expect(parseConfigReceiptWindowManifest({ ...good, refContractVersion: "v0" })).toBeNull();
  });
});

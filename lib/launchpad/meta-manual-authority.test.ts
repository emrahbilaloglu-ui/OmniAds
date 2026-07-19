import { describe, expect, it } from "vitest";
import {
  bindMetaLaunchpadManualAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  META_NATIVE_LINEAGE_FIELDS,
  META_LAUNCHPAD_MANUAL_AUTHORITY,
  metaLaunchpadActionLogAuthority,
} from "@/lib/launchpad/meta-manual-authority";

describe("Launchpad manual execution authority", () => {
  it("does not advertise unsupported pseudo-token lineage fields", () => {
    expect(META_NATIVE_LINEAGE_FIELDS).not.toContain("decisionExecutionToken");
    expect(META_NATIVE_LINEAGE_FIELDS).not.toContain("decision_execution_token");
  });

  it("accepts only the exact explicit operator contract", () => {
    expect(
      evaluateMetaLaunchpadManualAuthority({
        ...META_LAUNCHPAD_MANUAL_AUTHORITY,
        action: "launch",
        idempotencyKey: "manual_request_1",
        creativeBriefId: "brief_1",
      }),
    ).toEqual({
      ok: true,
      authority: META_LAUNCHPAD_MANUAL_AUTHORITY,
    });
  });

  it.each([
    [{}, "action_origin_required"],
    [
      {
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
      },
      "action_origin_required",
    ],
    [
      {
        actionOrigin: "launchpad_manual_v1",
        manualConfirmation: "yes",
      },
      "manual_confirmation_required",
    ],
    [
      {
        ...META_LAUNCHPAD_MANUAL_AUTHORITY,
        sourceDecisionId: null,
      },
      "mixed_action_origin_contract",
    ],
    [
      {
        ...META_LAUNCHPAD_MANUAL_AUTHORITY,
        decisionEvaluationId: "evaluation_1",
      },
      "mixed_action_origin_contract",
    ],
  ])("fails closed for %j", (body, code) => {
    expect(evaluateMetaLaunchpadManualAuthority(body)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it.each(
    META_NATIVE_LINEAGE_FIELDS.flatMap((field) => [
      [field, null],
      [field, ""],
    ]),
  )(
    "rejects presence of native lineage alias %s even when its value is %j",
    (field, value) => {
      expect(
        evaluateMetaLaunchpadManualAuthority({
          ...META_LAUNCHPAD_MANUAL_AUTHORITY,
          [field]: value,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "mixed_action_origin_contract" },
      });
    },
  );

  it("rejects a second action-origin alias even when it is empty", () => {
    expect(
      evaluateMetaLaunchpadManualAuthority({
        ...META_LAUNCHPAD_MANUAL_AUTHORITY,
        action_origin: "",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "mixed_action_origin_contract" },
    });
  });

  it("binds the exact authority to immutable payload and action-log evidence", () => {
    expect(
      bindMetaLaunchpadManualAuthorityToPayload(
        { mode: "new_campaign" },
        META_LAUNCHPAD_MANUAL_AUTHORITY,
      ),
    ).toEqual({
      mode: "new_campaign",
      executionAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
    });
    expect(
      metaLaunchpadActionLogAuthority({
        authority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        requestFingerprint: "fingerprint_1",
      }),
    ).toEqual({
      action_origin: "launchpad_manual_v1",
      manual_confirmation: "explicit_operator_confirmation",
      launch_intent_request_fingerprint: "fingerprint_1",
    });
  });
});

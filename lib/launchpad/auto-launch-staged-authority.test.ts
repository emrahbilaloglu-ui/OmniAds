/**
 * The second launch-execution authority, and the line between it and the first.
 *
 * A launch payload's `executionAuthority` is inside the request fingerprint, so
 * it is the one thing every later reader — the operator's own approval route,
 * the unattended sweep, and both durable receipts — agrees on. Until now it
 * could only say `{launchpad_manual_v1, explicit_operator_confirmation}`, which
 * means "a person was on the review screen and confirmed this provider write".
 *
 * A background producer cannot truthfully say that, and the previous delivery
 * therefore refused every unattended staging rather than lie. These cases pin
 * the second, honest pair it says instead, and pin that the two never merge:
 * the failure that would matter is not a missing authority, it is a
 * producer-staged launch that reads afterwards as an operator's own.
 */
import { describe, expect, it } from "vitest";
import {
  bindMetaLaunchExecutionAuthorityToPayload,
  evaluateMetaLaunchpadManualAuthority,
  isMetaLaunchpadStagedAuthority,
  metaLaunchpadActionLogAuthority,
  readMetaLaunchExecutionAuthority,
  META_LAUNCHPAD_MANUAL_AUTHORITY,
  META_LAUNCHPAD_STAGED_AUTHORITY,
} from "@/lib/launchpad/meta-manual-authority";

const FINGERPRINT = "b2c3d4e5f6a7b8c9";

describe("the two authorities are distinct, and neither can be half-read", () => {
  it("gives the producer words that do not claim an operator confirmation", () => {
    expect(META_LAUNCHPAD_STAGED_AUTHORITY).toEqual({
      actionOrigin: "launchpad_decision_staged_v1",
      manualConfirmation: "decision_staged_approval",
    });
    expect(META_LAUNCHPAD_STAGED_AUTHORITY.actionOrigin).not.toBe(
      META_LAUNCHPAD_MANUAL_AUTHORITY.actionOrigin,
    );
    expect(META_LAUNCHPAD_STAGED_AUTHORITY.manualConfirmation).not.toBe(
      META_LAUNCHPAD_MANUAL_AUTHORITY.manualConfirmation,
    );
    expect(isMetaLaunchpadStagedAuthority(META_LAUNCHPAD_STAGED_AUTHORITY)).toBe(true);
    expect(isMetaLaunchpadStagedAuthority(META_LAUNCHPAD_MANUAL_AUTHORITY)).toBe(false);
  });

  it("reads each pair back exactly, and nothing in between", () => {
    expect(readMetaLaunchExecutionAuthority({ ...META_LAUNCHPAD_MANUAL_AUTHORITY }))
      .toEqual(META_LAUNCHPAD_MANUAL_AUTHORITY);
    expect(readMetaLaunchExecutionAuthority({ ...META_LAUNCHPAD_STAGED_AUTHORITY }))
      .toEqual(META_LAUNCHPAD_STAGED_AUTHORITY);
    // The crossed pairs are the shape a caller would produce trying to look
    // like a confirmation it does not have.
    expect(
      readMetaLaunchExecutionAuthority({
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "explicit_operator_confirmation",
      }),
    ).toBeNull();
    expect(
      readMetaLaunchExecutionAuthority({
        actionOrigin: "launchpad_manual_v1",
        manualConfirmation: "decision_staged_approval",
      }),
    ).toBeNull();
    expect(readMetaLaunchExecutionAuthority(null)).toBeNull();
    expect(readMetaLaunchExecutionAuthority("launchpad_manual_v1")).toBeNull();
    expect(readMetaLaunchExecutionAuthority({ actionOrigin: "launchpad_manual_v1" }))
      .toBeNull();
  });

  it("binds either into a payload without touching the rest of it", () => {
    const payload = { mode: "add_to_existing", targetAdsetId: "23847000000202" };
    const staged = bindMetaLaunchExecutionAuthorityToPayload(
      payload,
      META_LAUNCHPAD_STAGED_AUTHORITY,
    );
    expect(staged).toEqual({ ...payload, executionAuthority: META_LAUNCHPAD_STAGED_AUTHORITY });
    // A copy, so a frozen module constant cannot be mutated through a payload.
    expect(staged.executionAuthority).not.toBe(META_LAUNCHPAD_STAGED_AUTHORITY);
    expect(readMetaLaunchExecutionAuthority(staged.executionAuthority))
      .toEqual(META_LAUNCHPAD_STAGED_AUTHORITY);
  });

  /*
    The request contract is UNCHANGED, and that is the guard this work must not
    have loosened. An HTTP caller still has to present the operator's own pair;
    the staged one is only ever written by the producer into a stored payload
    and is not a thing a request may claim.
  */
  it("still refuses a request body that presents the staged pair", () => {
    expect(evaluateMetaLaunchpadManualAuthority({ ...META_LAUNCHPAD_STAGED_AUTHORITY }))
      .toMatchObject({ ok: false, status: 400, error: { code: "action_origin_required" } });
    expect(
      evaluateMetaLaunchpadManualAuthority({
        actionOrigin: "launchpad_manual_v1",
        manualConfirmation: "decision_staged_approval",
      }),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "manual_confirmation_required" },
    });
    expect(evaluateMetaLaunchpadManualAuthority({ ...META_LAUNCHPAD_MANUAL_AUTHORITY }))
      .toEqual({ ok: true, authority: META_LAUNCHPAD_MANUAL_AUTHORITY });
  });
});

describe("the action log keeps the two apart", () => {
  it("says nothing extra when the operator staged and ran it themselves", () => {
    expect(
      metaLaunchpadActionLogAuthority({
        authority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        requestFingerprint: FINGERPRINT,
        stagedAuthority: META_LAUNCHPAD_MANUAL_AUTHORITY,
      }),
    ).toEqual({
      action_origin: "launchpad_manual_v1",
      manual_confirmation: "explicit_operator_confirmation",
      launch_intent_request_fingerprint: FINGERPRINT,
    });
  });

  /*
    The row an operator approves in the queue for a launch a DECISION staged.
    Both facts are true and both are needed: they confirmed the write, and they
    did not compose the payload.
  */
  it("names both when a person approved a producer-staged payload", () => {
    expect(
      metaLaunchpadActionLogAuthority({
        authority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        requestFingerprint: FINGERPRINT,
        stagedAuthority: META_LAUNCHPAD_STAGED_AUTHORITY,
      }),
    ).toEqual({
      action_origin: "launchpad_manual_v1",
      manual_confirmation: "explicit_operator_confirmation",
      launch_intent_request_fingerprint: FINGERPRINT,
      staged_execution_authority: {
        actionOrigin: "launchpad_decision_staged_v1",
        manualConfirmation: "decision_staged_approval",
      },
    });
  });

  it("omits the staged fact when there is none to report", () => {
    expect(
      metaLaunchpadActionLogAuthority({
        authority: META_LAUNCHPAD_MANUAL_AUTHORITY,
        requestFingerprint: FINGERPRINT,
      }),
    ).not.toHaveProperty("staged_execution_authority");
  });
});

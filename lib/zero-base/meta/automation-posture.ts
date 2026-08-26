/**
 * Meta stop, provider posture and the automation guardrail presentation.
 *
 * Two systems that look alike are kept deliberately apart. Meta readiness and
 * Google readiness are separate products with separate authorities, and a
 * single "stop everything" control would either lie about its reach or acquire
 * a reach it does not have. So:
 *
 * - the stop is **business-scoped and Meta-only**, and its copy is checked for
 *   any word that would imply otherwise;
 * - Google's posture is always drawn, always as a separate row, and always
 *   says it is unaffected. Omitting it when nothing is wrong is what teaches an
 *   operator that one switch covers both.
 *
 * There is no Google stop here and there must never be one: inventing a control
 * for an authority we do not own is worse than having none.
 */

export type ProviderSourceState =
  | "serving"
  | "partial"
  | "degraded"
  | "unavailable"
  /** The source could not be read. Distinct from "nothing to serve". */
  | "unknown";

export interface ProviderPosture {
  provider: "meta" | "google";
  label: string;
  state: ProviderSourceState;
  /** Required whenever the state is not `serving`. */
  reason: string | null;
  /** True only for the provider this surface can actually stop. */
  stoppable: boolean;
  /**
   * What the state is a claim about.
   *
   * Google's row reports a **connection**, read from its own separate
   * authority. It is never a health claim: Google readiness is a different
   * system with a different surface, and asserting health from a connection
   * boolean would be a fact nobody measured.
   */
  basis: "automation_control_plane" | "connection_only";
}

/** Words that would over-claim the stop's reach. */
export const FORBIDDEN_STOP_PHRASES = [
  "global",
  "stop all",
  "all providers",
  "everything",
  "kill all",
  "all platforms",
] as const;

export const META_STOP_LABEL = "Stop Meta automation for this business";
export const META_STOP_SCOPE_NOTE =
  "This stops automated Meta actions for this business only. Other businesses and Google are unaffected.";
export const GOOGLE_UNAFFECTED_ROW =
  "Google Ads — unaffected. Meta stop does not reach Google, and there is no Google stop here.";

/** True when copy over-claims the stop's reach. */
export function overclaimsStopReach(text: string): boolean {
  const lowered = text.toLowerCase();
  return FORBIDDEN_STOP_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * Provider rows, always both, in a fixed order.
 *
 * Google is present even when it is perfectly healthy, because its absence is
 * what makes a Meta-only control look global.
 *
 * Google's state comes from an actual read of its own connection authority. A
 * hard-coded "serving" would have been a fabricated health claim about a
 * provider this surface never queried — the exact failure the separate-systems
 * rule exists to prevent.
 */
export function buildProviderPostures(input: {
  meta: { state: ProviderSourceState; reason: string | null };
  google: GoogleConnectionRead;
}): ProviderPosture[] {
  return [
    {
      provider: "meta",
      label: "Meta Ads",
      state: input.meta.state,
      reason: input.meta.reason,
      stoppable: true,
      basis: "automation_control_plane",
    },
    {
      provider: "google",
      label: "Google Ads",
      ...googlePosture(input.google),
      stoppable: false,
      basis: "connection_only",
    },
  ];
}

/** Result of reading Google's own connection authority. */
export type GoogleConnectionRead =
  | { read: true; connected: boolean }
  | { read: false; reason: string };

/**
 * Google's row, from what was actually read.
 *
 * When the read failed the state is `unknown` with the reason — never
 * `serving`. Reporting health we did not measure is worse than reporting that
 * we could not measure it.
 */
export function googlePosture(read: GoogleConnectionRead): {
  state: ProviderSourceState;
  reason: string;
} {
  if (!read.read) {
    return {
      state: "unknown",
      reason: `Google posture could not be read: ${read.reason} ${GOOGLE_UNAFFECTED_ROW}`,
    };
  }
  if (!read.connected) {
    return {
      state: "unavailable",
      reason: `Google Ads is not connected for this business. ${GOOGLE_UNAFFECTED_ROW}`,
    };
  }
  // Connected is a connection fact, stated as one.
  return { state: "serving", reason: GOOGLE_UNAFFECTED_ROW };
}

/* ------------------------------------------------------------- stop ceremony */

export type StopCeremonyStep =
  | "blocked"
  | "confirm"
  | "awaiting_read_back"
  | "settled";

export interface StopCeremonyBlocker {
  code:
    | "reviewer"
    | "demo"
    | "insufficient_role"
    | "state_unavailable"
    | "gate_closed"
    | "preflight_unavailable"
    | "preflight_stale";
  message: string;
}

/**
 * How old the control-plane read may be before the ceremony refuses.
 *
 * Five minutes. The stop is a safety control and the question it answers is
 * "what is the state RIGHT NOW" — a confirmation typed against a reading from
 * half an hour ago is a confirmation of a screen, not of a system. The number
 * is deliberately shorter than the workspace's own cache windows so that a
 * cached page cannot carry a stale reading into a typed confirmation.
 */
export const STOP_PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The persisted read this ceremony is confirmed against.
 *
 * Not a second control plane and not a new endpoint: it is
 * `MetaAutomationControlPlane.sections.businessControl`, which the server
 * already stamps with the instant the read was ATTEMPTED and the error code
 * when it failed. Using it means the operator confirms against the same read
 * the screen is drawn from, and that the age of that read is a fact rather
 * than an assumption.
 */
export interface StopCeremonyPreflight {
  status: "complete" | "unavailable" | "migration_required";
  errorCode: string | null;
  /** The instant the read was attempted, ISO-8601. */
  observedAt: string;
}

export interface StopCeremonyInput {
  intent: "engage" | "release";
  viewer: { role: "admin" | "collaborator" | "guest" | null; isReviewer: boolean; demo: boolean };
  /** Null when the control-plane state could not be read. */
  currentlyEngaged: boolean | null;
  /**
   * The server's own refusal for ENGAGE when `META_AUTOMATION_STOP_UI` is shut.
   *
   * Passed in rather than read here, because a client cannot read a server gate
   * and a client that guessed one would eventually disagree with the route.
   * Null means the gate is open — or, on a caller that does not know, that this
   * ceremony makes no claim about it and the route remains the authority.
   */
  gateClosedReason?: string | null;
  /**
   * The control-plane read this confirmation is made against, and its age.
   *
   * `undefined` from a caller that does not supply one keeps the previous
   * behaviour, so the ceremony can still be resolved by a surface that has no
   * per-section provenance to offer. `null` means the caller HAS the envelope
   * and it carried no reading — which is a refusal, not an omission.
   */
  preflight?: StopCeremonyPreflight | null;
  /** Clock for the preflight age. Injected so this stays pure. */
  now?: number;
  /**
   * Independent server re-read after the write. Null until it has happened.
   *
   * `engaged: null` means the re-read itself failed — which is neither success
   * nor failure, and must be reported as unknown rather than resolved either
   * way.
   */
  readBack: { engaged: boolean | null; readAt: string; error?: string | null } | null;
}

export interface StopCeremonyState {
  step: StopCeremonyStep;
  blocker: StopCeremonyBlocker | null;
  /** Only ever true after a successful read-back. */
  showStatusBanner: boolean;
  statusMessage: string | null;
}

/**
 * Resolves the stop ceremony.
 *
 * The rule that matters most: no status banner before the read-back. Reporting
 * "automation stopped" from a 200 response claims a state nobody has observed,
 * and if the write did not take effect the operator believes spend is halted
 * when it is not.
 */
export function resolveStopCeremony(input: StopCeremonyInput): StopCeremonyState {
  const deny = (blocker: StopCeremonyBlocker): StopCeremonyState => ({
    step: "blocked",
    blocker,
    showStatusBanner: false,
    statusMessage: null,
  });

  if (input.viewer.isReviewer) {
    return deny({
      code: "reviewer",
      message: "Reviewer sessions cannot change automation state.",
    });
  }
  if (input.viewer.demo) {
    return deny({
      code: "demo",
      message: "The demo business has no automation control.",
    });
  }
  /*
   * The role floor is DIRECTION-AWARE, and matches the route exactly.
   *
   * `app/api/meta/automation/route.ts` takes `collaborator` for
   * `engage_kill_switch` and `admin` for `release_kill_switch`, and the reason
   * is stated there: engaging a stop is a safety action anyone trusted with the
   * account should be able to take in the moment they need it, while releasing
   * one re-enables spend.
   *
   * This used to refuse a collaborator in BOTH directions. That is stricter
   * than the server, which sounds safe and is not: it hid the emergency control
   * from exactly the operator the route would have accepted, and a surface that
   * refuses what the server permits teaches its operators that the product is
   * unreliable in the one moment they cannot afford to doubt it.
   */
  const floor = input.intent === "release" ? "admin" : "collaborator";
  const permitted =
    floor === "admin"
      ? input.viewer.role === "admin"
      : input.viewer.role === "admin" || input.viewer.role === "collaborator";
  if (!permitted) {
    return deny({
      code: "insufficient_role",
      message:
        floor === "admin"
          ? "Only a business admin can release the Meta automation stop."
          : "Only a collaborator or admin can stop Meta automation for this business.",
    });
  }
  /*
   * The gate holds ENGAGE and never holds RELEASE.
   *
   * The route says why in as many words: a stop that cannot be released is
   * worse than no stop, so whatever the rollout state, an existing stop must
   * always be liftable. Refused after the caller facts above, in the same
   * precedence the route uses, so an operator is told the refusal that is about
   * THEM before the one that is about the deployment.
   */
  if (input.intent === "engage" && input.gateClosedReason) {
    return deny({ code: "gate_closed", message: input.gateClosedReason });
  }
  /*
   * The persisted preflight, when the caller has one.
   *
   * A typed confirmation is a confirmation of a READING. If the reading failed,
   * there is nothing to confirm against; if it is old, the operator is
   * confirming a screen rather than a system. Both refuse, and both say which.
   */
  if (input.preflight !== undefined) {
    if (!input.preflight) {
      return deny({
        code: "preflight_unavailable",
        message:
          "No control-plane reading is available for this account, so there is nothing to confirm the change against.",
      });
    }
    if (input.preflight.status !== "complete") {
      return deny({
        code: "preflight_unavailable",
        message:
          "The control-plane reading did not complete" +
          (input.preflight.errorCode ? ` (${input.preflight.errorCode})` : "") +
          ", so the current state is unproven and must not be changed blind.",
      });
    }
    const observed = Date.parse(input.preflight.observedAt);
    const now = input.now ?? Date.now();
    if (!Number.isFinite(observed)) {
      return deny({
        code: "preflight_unavailable",
        message:
          "The control-plane reading carries no usable observation time, so its age cannot be established.",
      });
    }
    if (now - observed > STOP_PREFLIGHT_MAX_AGE_MS) {
      return deny({
        code: "preflight_stale",
        message: `The control-plane reading is from ${input.preflight.observedAt} and is older than ${Math.round(STOP_PREFLIGHT_MAX_AGE_MS / 60000)} minutes. Re-read the control plane before changing the stop.`,
      });
    }
  }

  /*
   * Last of the refusals, and deliberately after the preflight.
   *
   * Both say "the current state is unknown". The preflight says WHY — the read
   * failed with this code, or it is this many minutes old — and the more
   * specific sentence is the one an operator can act on. This one remains for
   * a caller that supplies no preflight at all.
   */
  if (input.currentlyEngaged === null) {
    return deny({
      code: "state_unavailable",
      message: "The current automation state could not be read, so it must not be changed blind.",
    });
  }
  if (!input.readBack) {
    return { step: "confirm", blocker: null, showStatusBanner: false, statusMessage: null };
  }

  // The read-back is the only thing that may produce a status claim.
  const expected = input.intent === "engage";
  if (input.readBack.engaged === null) {
    // The write was submitted and the confirming read failed. Claiming either
    // outcome here would be a guess about whether spend is still running.
    return {
      step: "awaiting_read_back",
      blocker: null,
      showStatusBanner: false,
      statusMessage:
        "The change was submitted but the state could not be read back" +
        (input.readBack.error ? ` (${input.readBack.error})` : "") +
        ". Treat automation state as unknown until it can be confirmed.",
    };
  }
  if (input.readBack.engaged !== expected) {
    return {
      step: "awaiting_read_back",
      blocker: null,
      showStatusBanner: false,
      statusMessage:
        "The change was submitted but the read-back does not confirm it. Treat automation state as unknown.",
    };
  }

  return {
    step: "settled",
    blocker: null,
    showStatusBanner: true,
    statusMessage: expected
      ? `Meta automation is stopped for this business. Confirmed by read-back at ${input.readBack.readAt}.`
      : `Meta automation is running again for this business. Confirmed by read-back at ${input.readBack.readAt}.`,
  };
}

/* ---------------------------------------------------------------- guardrails */

/**
 * AUTO-05…10 are read-only in the canonical surface.
 *
 * They describe caps the engine enforces server-side. An edit control here
 * would imply the buyer can change a limit the engine will not honour, so the
 * count of edit affordances must be exactly zero.
 */
export const READ_ONLY_GUARDRAIL_IDS = [
  "AUTO-05",
  "AUTO-06",
  "AUTO-07",
  "AUTO-08",
  "AUTO-09",
  "AUTO-10",
] as const;

export interface GuardrailRow {
  id: (typeof READ_ONLY_GUARDRAIL_IDS)[number];
  label: string;
  value: string;
  /** Always false: the canonical surface renders guardrails, never edits them. */
  editable: false;
}

export function buildGuardrailRows(
  guardrails: Readonly<Record<string, unknown>>,
): GuardrailRow[] {
  const value = (raw: unknown) =>
    raw === null || raw === undefined ? "Not configured" : String(raw);
  return [
    { id: "AUTO-05", label: "Daily automatic action cap", value: value(guardrails.dailyAutoActionCap), editable: false },
    { id: "AUTO-06", label: "Per-action spend ceiling", value: value(guardrails.perActionSpendCeilingMinor), editable: false },
    { id: "AUTO-07", label: "Minimum confidence to act", value: value(guardrails.minimumConfidence), editable: false },
    { id: "AUTO-08", label: "Cool-down between actions", value: value(guardrails.cooldownMinutes), editable: false },
    { id: "AUTO-09", label: "Required evidence freshness", value: value(guardrails.maxEvidenceAgeHours), editable: false },
    { id: "AUTO-10", label: "Blocked while kill switch engaged", value: "Always", editable: false },
  ];
}

/* -------------------------------------------------------------- replay/actor */

/**
 * A replayed window is permanently marked.
 *
 * Replayed history was recomputed after the fact, so it did not drive the
 * decisions taken at the time. The banner is not dismissible: dismissing it
 * would let a later reader treat a reconstruction as a contemporaneous record.
 */
export const REPLAY_BANNER =
  "Part of this history was replayed after the fact. Replayed rows describe what the engine would decide now, not what it decided then.";

export const ACTOR_NOT_RECORDED =
  "Actor not recorded — this entry predates actor capture, so who made the change is unknown.";

/** Attribution for a history row, without inventing an actor. */
export function actorLabel(actor: string | null | undefined): string {
  const value = (actor ?? "").trim();
  // "System" would be a claim; unknown is the truth.
  return value.length > 0 ? value : ACTOR_NOT_RECORDED;
}

/**
 * v2 emitter validation.
 *
 * The allowlist is closed (INSTR-01): a (surface, event) pair that is not in
 * the vendored ledger is refused, and so is any property key the ledger does
 * not list for that pair. Two things follow that are easy to get wrong:
 *
 * - `actor_role` and `width_bucket` are *server-derived*. A client that could
 *   name its own role could relabel its own telemetry, so a submitted value is
 *   ignored rather than trusted.
 * - Only the 15 pre-auth public surfaces may be emitted without a session.
 *   Everything else needs one, so an anonymous caller cannot probe which
 *   business ids exist by watching which events are accepted.
 *
 * Nothing here accepts a URL, a query string, or provider content: the
 * permitted keys are ids and buckets, and the payload is size-bounded.
 */
import {
  GENERATED_INSTRUMENTATION,
  type GeneratedInstrumentationRow,
} from "@/lib/zero-base/generated-contracts";
import {
  ACTOR_ROLES,
  WIDTH_BUCKETS,
  type ActorRole,
  type WidthBucket,
} from "@/lib/zero-base/instrumentation-schema";

export const MAX_PROPERTIES_BYTES = 2048;

const BY_PAIR = new Map<string, GeneratedInstrumentationRow>(
  GENERATED_INSTRUMENTATION.map((row) => [`${row.surface}::${row.event}`, row]),
);

/** Keys the server owns; a client-supplied value is never used. */
const SERVER_DERIVED = new Set(["actor_role", "width_bucket", "surface", "ts"]);

export type InstrumentationRejection =
  | { code: "unknown_pair"; status: 400; message: string }
  | { code: "disallowed_property"; status: 400; message: string }
  | { code: "invalid_property_value"; status: 400; message: string }
  | { code: "payload_too_large"; status: 413; message: string }
  | { code: "anonymous_not_permitted"; status: 403; message: string };

export interface InstrumentationSubmission {
  surface: string;
  event: string;
  /** Client-generated idempotency key. */
  eventId?: string | null;
  properties?: Record<string, unknown> | null;
  businessId?: string | null;
  accountId?: string | null;
}

export interface InstrumentationServerContext {
  authenticated: boolean;
  actorRole: ActorRole;
  widthBucket: WidthBucket;
}

export interface AcceptedInstrumentationEvent {
  surface: string;
  event: string;
  eventId: string | null;
  actorRole: ActorRole;
  widthBucket: WidthBucket;
  businessId: string | null;
  accountId: string | null;
  properties: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function findInstrumentationRow(
  surface: string,
  event: string,
): GeneratedInstrumentationRow | null {
  return BY_PAIR.get(`${surface}::${event}`) ?? null;
}

/**
 * Validates a submission against the closed allowlist.
 *
 * Returns either the row to write — with server-derived fields substituted —
 * or the exact rejection, including the status the route should use.
 */
export function validateInstrumentationEvent(
  submission: InstrumentationSubmission,
  context: InstrumentationServerContext,
): { ok: true; event: AcceptedInstrumentationEvent } | { ok: false; rejection: InstrumentationRejection } {
  const row = findInstrumentationRow(submission.surface, submission.event);
  if (!row) {
    return {
      ok: false,
      rejection: {
        code: "unknown_pair",
        status: 400,
        message: "Unknown surface/event pair.",
      },
    };
  }

  if (!context.authenticated && !row.anonymous) {
    return {
      ok: false,
      rejection: {
        code: "anonymous_not_permitted",
        status: 403,
        message: "This surface requires an authenticated session.",
      },
    };
  }

  const submitted = submission.properties ?? {};
  const encoded = JSON.stringify(submitted);
  if (encoded.length > MAX_PROPERTIES_BYTES) {
    return {
      ok: false,
      rejection: {
        code: "payload_too_large",
        status: 413,
        message: `Properties exceed ${MAX_PROPERTIES_BYTES} bytes.`,
      },
    };
  }

  const permitted = new Set<string>(row.properties);
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (!permitted.has(key)) {
      return {
        ok: false,
        rejection: {
          code: "disallowed_property",
          status: 400,
          message: `Property "${key}" is not declared for this surface.`,
        },
      };
    }
    // The server owns these; a submitted copy is dropped rather than trusted.
    if (SERVER_DERIVED.has(key)) continue;
    if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
      return {
        ok: false,
        rejection: {
          code: "invalid_property_value",
          status: 400,
          message: `Property "${key}" must be an opaque id.`,
        },
      };
    }
    properties[key] = value;
  }

  const eventId = submission.eventId ?? null;
  if (eventId !== null && !UUID.test(eventId)) {
    return {
      ok: false,
      rejection: {
        code: "invalid_property_value",
        status: 400,
        message: "eventId must be a UUID.",
      },
    };
  }

  const accountId = submission.accountId ?? null;
  if (accountId !== null && !OPAQUE_ID.test(accountId)) {
    return {
      ok: false,
      rejection: {
        code: "invalid_property_value",
        status: 400,
        message: "accountId must be an opaque id.",
      },
    };
  }

  return {
    ok: true,
    event: {
      surface: row.surface,
      event: row.event,
      eventId,
      // Substituted, never read from the submission.
      actorRole: context.actorRole,
      widthBucket: context.widthBucket,
      businessId: submission.businessId ?? null,
      accountId,
      properties,
    },
  };
}

/** Maps a viewport width onto the bucket the design uses. */
export function widthBucketFor(width: number): WidthBucket {
  if (width < 390) return "w320";
  if (width < 768) return "w390";
  if (width < 1280) return "w768";
  if (width < 1440) return "w1280";
  return "w1440";
}

export { ACTOR_ROLES, WIDTH_BUCKETS };

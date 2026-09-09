/**
 * `fbtrace_id` IS THE ONLY FREE-FORM PROVIDER STRING THIS CODEBASE CARRIES, AND
 * IT REACHED DURABLE OPERATOR-FACING RECORDS UNVETTED.
 *
 * Codex Round 6, item 6. Every other field kept out of a Meta error body is a
 * number (`code`, `error_subcode`), a boolean (`is_transient`) or our own HTTP
 * status, and the failure messages are composed from those precisely so a third
 * party cannot write into `meta_sync_partitions.last_error`,
 * `meta_sync_runs.error_message`, a persisted `MetaPaginationFailure` or an
 * operator log. The trace id was accepted with `String(...).trim()` and nothing
 * else, so prose, a quoted request including its access token, newlines that
 * split a log line in two, the `:`/`=`/space delimiters those messages use as
 * structure, and unbounded length all travelled the whole way.
 *
 * The rule is one shared pattern applied at BOTH boundaries — when the identity
 * is parsed and again when a message is formatted — and a value that fails it
 * is dropped rather than repaired: trimming or escaping would keep
 * provider-chosen bytes in the record while implying they had been vetted.
 */
import { describe, expect, it } from "vitest";

import {
  isSafeMetaGraphTraceId,
  sanitizeMetaGraphTraceId,
} from "@/lib/meta/graph-trace-id";
import { durableMetaFailureMessage } from "@/lib/sync/meta-sync";

/**
 * Values a provider — or anything answering as one — could return.
 *
 * The control characters are written as escapes rather than as literal bytes so
 * the fixture itself stays readable and greppable.
 */
const ADVERSARIAL: Array<[name: string, value: unknown, forbidden: string]> = [
  ["prose", "trace not available for this request", "not available"],
  [
    "a quoted request carrying a credential",
    "AbCd?access_token=EAAG-SECRET-TOKEN-VALUE&appsecret_proof=deadbeef",
    "EAAG-SECRET-TOKEN-VALUE",
  ],
  ["a newline that splits a log line", "AbCd\nfbtrace=SPOOFED", "SPOOFED"],
  ["a carriage return", "AbCd\r\nlevel=info", "level=info"],
  ["a NUL byte", "AbCd\u0000SPOOFED", "SPOOFED"],
  ["an ANSI control sequence", "\u001b[31mAbCd\u001b[0m", "\u001b[31m"],
  ["a tab", "AbCd\tEfGh", "EfGh"],
  [
    "the message's own delimiters",
    "code=999 subcode=888 fbtrace=SPOOFED",
    "SPOOFED",
  ],
  ["a colon delimiter", "spoofed:refusal", "spoofed:refusal"],
  ["a space", "AbCd EfGh", "AbCd EfGh"],
  ["overlength data", "A".repeat(65), "A".repeat(65)],
  ["a JSON object", { nested: "AbCd" }, "nested"],
  ["an array", ["AbCd"], "AbCd"],
  ["a number", 190, "fbtrace=190"],
  ["a boolean", true, "fbtrace=true"],
  ["an empty string", "", "fbtrace= "],
  ["whitespace only", "   ", "fbtrace= "],
  ["null", null, "fbtrace=null"],
  ["undefined", undefined, "fbtrace=undefined"],
];

/** Shapes Meta actually returns, which must survive untouched. */
const VALID: string[] = [
  "AbCdEfGhIjKlMnOp",
  "A_b-C_d-1234",
  "0",
  "A".repeat(64),
];

describe("the shared trace-id rule", () => {
  it.each(ADVERSARIAL)("drops %s entirely", (_name, value) => {
    expect(sanitizeMetaGraphTraceId(value)).toBeNull();
    expect(isSafeMetaGraphTraceId(value)).toBe(false);
  });

  it.each(VALID)("preserves the real trace id %s", (value) => {
    expect(sanitizeMetaGraphTraceId(value)).toBe(value);
    expect(isSafeMetaGraphTraceId(value)).toBe(true);
  });

  it("tolerates transport whitespace around an otherwise valid id", () => {
    // Surrounding whitespace is a transport artefact, not content.
    expect(sanitizeMetaGraphTraceId("  AbCdEfGh  ")).toBe("AbCdEfGh");
  });

  it("refuses one character past the ceiling", () => {
    // The boundary itself, so a future widening has to face this line.
    expect(sanitizeMetaGraphTraceId("A".repeat(64))).toBe("A".repeat(64));
    expect(sanitizeMetaGraphTraceId("A".repeat(65))).toBeNull();
  });
});

describe("the durable sync failure record", () => {
  /** A carrier shaped exactly like `MetaGraphRequestError`. */
  const carrier = (fbtraceId: unknown) =>
    Object.assign(new Error("meta_bulk_page_http_failure:status=400"), {
      name: "MetaGraphRequestError",
      termination: "http_failure",
      httpStatus: 400,
      errorCode: 190,
      errorSubcode: 463,
      isTransient: false,
      fbtraceId,
    });

  it.each(ADVERSARIAL)(
    "writes none of %s into the durable message",
    (_name, value, forbidden) => {
      const durable = durableMetaFailureMessage(carrier(value));
      // The record is still structured and still says what happened.
      expect(durable).toContain("meta_graph_refusal:http_failure");
      expect(durable).toContain("code=190");
      expect(durable).toContain("subcode=463");
      // And the provider's bytes are gone, replaced by a named absence.
      expect(durable).toContain("fbtrace=none");
      /*
        `forbidden` is the fragment that identifies THIS value — the credential,
        the injected key, the control sequence, or the value itself. Asserting
        on a per-case marker rather than on every whitespace-separated token is
        deliberate: the record legitimately contains words like "trace" and
        "code=", so a token sweep would fail on the record's own vocabulary and
        would have to be loosened until it proved nothing.
      */
      expect(durable).not.toContain(forbidden);
      // One line, always: a newline here would split the durable record.
      expect(durable.split("\n")).toHaveLength(1);
      // And no control character survives anywhere in it.
      expect(/[\u0000-\u001f\u007f]/.test(durable)).toBe(false);
    },
  );

  it("keeps a valid trace id, because it is the operator's handle to Meta support", () => {
    const durable = durableMetaFailureMessage(carrier("AbCdEfGhIjKlMnOp"));
    expect(durable).toContain("fbtrace=AbCdEfGhIjKlMnOp");
  });

  it("leaves this codebase's own error messages alone", () => {
    // Not a Graph refusal: a lease conflict, a database error, an assertion.
    // Suppressing these would blind the operator to failures they can act on.
    expect(durableMetaFailureMessage(new Error("lease lost before completion")))
      .toBe("lease lost before completion");
  });
});

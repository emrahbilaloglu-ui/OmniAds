import { describe, expect, it } from "vitest";

import { buildAudienceBreakdowns } from "./legacy-page";

/**
 * The Audiences screen drew five breakdown panels and rendered an em dash in
 * every one, on every account, because the page issued no read at all — while
 * `/api/meta/breakdowns` had been serving age, placement and location with real
 * spend the whole time.
 */
const row = (key: string, spend: number, revenue: number) => ({
  key,
  label: key,
  spend,
  revenue,
  purchases: 0,
  clicks: 0,
  impressions: 0,
});

describe("the audience breakdown panels bind the served rows", () => {
  const payload = {
    status: "ok",
    age: [row("65+", 75, 150), row("25-34", 25, 10)],
    placement: [
      row("facebook|feed|iphone", 60, 120),
      row("facebook|story|android", 20, 20),
      row("instagram|feed|iphone", 20, 60),
    ],
  };

  // Percent, not a fraction: the bar reads `--share: {n}%` and the caption
  // formats the same number, so a 0-1 value rendered every row as 0%.
  it("computes spend share against the panel's own total and ROAS from the same row", () => {
    const age = buildAudienceBreakdowns(payload).find((p) => p.id === "age");
    expect(age?.rows.map((r) => [r.label, r.spendShare, r.roas])).toEqual([
      ["65+", 75, 2],
      ["25-34", 25, 0.4],
    ]);
  });

  it("regroups platform from the placement key the server produced", () => {
    const platform = buildAudienceBreakdowns(payload).find(
      (p) => p.id === "platform",
    );
    // facebook = 60 + 20 spend, 120 + 20 revenue -> share 0.8, ROAS 1.75
    expect(platform?.rows.map((r) => [r.label, r.spendShare, r.roas])).toEqual([
      ["facebook", 80, 1.75],
      ["instagram", 20, 3],
    ]);
  });

  it("leaves gender and frequency empty rather than deriving them", () => {
    const built = buildAudienceBreakdowns(payload);
    expect(built.find((p) => p.id === "gender")?.rows).toEqual([]);
    expect(built.find((p) => p.id === "frequency")?.rows).toEqual([]);
  });

  /**
   * The law changed because the pipeline did, so this restates it rather than
   * being deleted.
   *
   * It used to say these panels can NEVER fill: gender was summed away at the
   * write and reach was never requested from Meta. Both are fixed at the
   * source now — the two dimensions are written under separate identities and
   * reach is on the insights field list — so "never" would itself be the false
   * statement. What remains true is narrower and time-bounded: a day WRITTEN
   * BEFORE those fixes holds no gender rows and a stored reach of 0 that was
   * never a measurement, and neither can be reconstructed from the blend it
   * was merged into. Empty is still not the same fact as unmeasured, so the
   * note must scope the gap to the range instead of condemning the pipeline.
   */
  it("scopes the gender and frequency gap to the range rather than calling it permanent", () => {
    const built = buildAudienceBreakdowns(payload);
    const gender = built.find((p) => p.id === "gender")?.note ?? "";
    const frequency = built.find((p) => p.id === "frequency")?.note ?? "";
    expect(gender).toBe("Gender breakdown is unavailable for this date range.");
    expect(frequency).toBe("Frequency is unavailable for this date range.");
    // The banned claim is PERMANENCE ("can never fill", "cannot fill"), not
    // the word "never" itself — "a zero that was never a measurement"
    // describes the past honestly and must stay sayable.
    const permanence = /can never|can't ever|cannot |can not /i;
    expect(gender).not.toMatch(permanence);
    expect(frequency).not.toMatch(permanence);
  });

  /**
   * And when the split IS present for the range, the panel draws it. Without
   * this the ingestion fix could land and the surface would keep withholding
   * forever with nothing failing.
   */
  it("draws the gender panel once the range carries the split", () => {
    const built = buildAudienceBreakdowns({
      ...payload,
      gender: [
        {
          key: "female",
          label: "Female",
          spend: 600,
          purchases: 12,
          revenue: 1800,
          clicks: 900,
          impressions: 40000,
        },
        {
          key: "male",
          label: "Male",
          spend: 400,
          purchases: 7,
          revenue: 900,
          clicks: 610,
          impressions: 26000,
        },
      ],
    });
    const gender = built.find((p) => p.id === "gender");
    expect(gender?.rows).toHaveLength(2);
    expect(gender?.note).toBeNull();
  });

  /**
   * A range the warehouse is still backfilling must not read as a finished
   * measurement. The rows stay, while internal sync wording stays out of the
   * operator-facing panels.
   */
  it("carries the served reason onto the panels while a range is still partial", () => {
    const built = buildAudienceBreakdowns({
      ...payload,
      isPartial: true,
      notReadyReason: "Breakdown warehouse data is still being prepared.",
    });
    expect(built.find((p) => p.id === "age")?.note).toBe(
      "Some audience data is unavailable. Try again.",
    );
    expect(built.find((p) => p.id === "platform")?.note).toBe(
      "Some audience data is unavailable. Try again.",
    );
    // A complete range says nothing rather than inventing a caveat.
    expect(
      buildAudienceBreakdowns(payload).find((p) => p.id === "age")?.note,
    ).toBeNull();
  });

  it("withholds every panel when the read did not succeed", () => {
    for (const bad of [null, { status: "no_connection" as const }]) {
      const built = buildAudienceBreakdowns(bad);
      expect(built).toHaveLength(5);
      expect(built.every((p) => p.rows.length === 0)).toBe(true);
    }
  });

  /**
   * A read failure presented as an empty success is the exact confusion this
   * screen used to produce: a 500, a disconnected integration and an account
   * with genuinely no data all rendered as five silent em-dash panels. The
   * panels state that data is unavailable without exposing backend details.
   */
  it("states the reason on every panel when the read failed or was refused", () => {
    const refused = buildAudienceBreakdowns({
      status: "account_not_assigned",
      notReadyReason:
        "The requested Meta ad account is not assigned to this workspace.",
    });
    expect(
      refused.every(
        (p) => p.note === "Audience data is unavailable. Try again.",
      ),
    ).toBe(true);

    const failed = buildAudienceBreakdowns(
      null,
      "Meta breakdowns could not be read (500).",
    );
    expect(
      failed.every(
        (p) => p.note === "Audience data is unavailable. Try again.",
      ),
    ).toBe(true);
  });

  it("gives a row with no spend no ROAS rather than zero", () => {
    const built = buildAudienceBreakdowns({
      status: "ok",
      age: [row("65+", 0, 0)],
      placement: [],
    });
    expect(built.find((p) => p.id === "age")?.rows[0]?.roas).toBeNull();
  });
});

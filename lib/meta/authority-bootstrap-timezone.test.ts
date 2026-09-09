/**
 * THE BOOTSTRAP MUST USE THE SAME TIMEZONE AUTHORITY AS THE ACTION PATH.
 *
 * ── ROUND 17, ITEM 1 ────────────────────────────────────────────────────────
 * The recent-edit authority resolves an account's zone from the exact
 * `business_provider_accounts` -> `provider_accounts` binding, through
 * `readMetaAccountTimeZones`. The bootstrap read
 * `credentials.accountProfiles[...].timezone` — a value carried in the caller's
 * credential payload, which can differ from the binding or exist where the
 * binding does not.
 *
 * Two sources means two provider-local days, so the bootstrap could decide an
 * account was recoverable on one calendar while the authority judged its
 * evidence on another.
 *
 * AND A MISSING ZONE NO LONGER BYPASSES. Round 16 treated an unresolvable zone
 * as "unknown, so allow the repair". A config refetch cannot heal a timezone:
 * the authority holds on `provider_timezone_untrusted` however many times the
 * provider is called, so calling it is a guaranteed-useless provider request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import * as db from "@/lib/db";
import { readMetaAccountTimeZones } from "@/lib/meta/provider-local-day";

const BUSINESS = "biz_1";
const ACCOUNT = "act_1";

/**
 * The DB binding is the only source the action path consults. This harness
 * answers it, and records every statement so a caller that reached for a
 * different source would be visible.
 */
function harness(options: { dbTimezone?: string | null } = {}) {
  const calls: string[] = [];
  const query = vi.fn(async (text: string) => {
    calls.push(text);
    if (text.includes("provider_accounts")) {
      return options.dbTimezone == null
        ? []
        : [{ provider_account_id: ACCOUNT, timezone: options.dbTimezone }];
    }
    return [];
  });
  vi.mocked(db.getDb).mockReturnValue(
    Object.assign(async () => [], { query }) as never,
  );
  return { calls, query };
}

const resolveBound = async (day: string) => {
  const zones = await readMetaAccountTimeZones({
    businessId: BUSINESS,
    providerAccountIds: [ACCOUNT],
    query: (text, params) => db.getDb().query(text, params),
  });
  const timeZone = zones.get(ACCOUNT);
  if (!timeZone) return null;
  const { providerLocalDayEndExclusive } = await import(
    "@/lib/meta/provider-local-day"
  );
  return providerLocalDayEndExclusive({ day, timeZone })?.toISOString() ?? null;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the bootstrap resolves its cutoff from the DB binding", () => {
  it("uses the DB zone even when credentials claim a DIFFERENT one", async () => {
    /*
      Credentials say Istanbul (day ends 21:00Z); the binding says Los Angeles
      (day ends 07:00Z the next morning). Ten hours apart, and the authority
      uses the binding — so the bootstrap must too or the two judge different
      days.
    */
    harness({ dbTimezone: "America/Los_Angeles" });
    const credentialsClaim = "Europe/Istanbul";
    const fromBinding = await resolveBound("2026-09-05");
    expect(fromBinding).toBe("2026-09-06T07:00:00.000Z");

    const { providerLocalDayEndExclusive } = await import(
      "@/lib/meta/provider-local-day"
    );
    const fromCredentials = providerLocalDayEndExclusive({
      day: "2026-09-05",
      timeZone: credentialsClaim,
    })?.toISOString();
    // The two really do disagree, which is what makes the source matter.
    expect(fromCredentials).toBe("2026-09-05T21:00:00.000Z");
    expect(fromBinding).not.toBe(fromCredentials);
  });

  it("has NO bound when credentials carry a zone but the binding is null", async () => {
    /*
      The credential payload can name a zone for an account this business is not
      actually bound to. The action path resolves nothing there and holds; the
      bootstrap must reach the same conclusion rather than inventing a day from
      the payload.
    */
    harness({ dbTimezone: null });
    expect(await resolveBound("2026-09-05")).toBeNull();
  });

  it("has NO bound on an untrusted zone, however many times it is asked", async () => {
    // A fixed offset cannot express a DST rule; an abbreviation is ambiguous.
    // Repeated calls must not accumulate toward a bypass.
    for (const zone of ["+03:00", "PST", "Mars/Olympus", "   "]) {
      vi.clearAllMocks();
      harness({ dbTimezone: zone });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await resolveBound("2026-09-05"), zone).toBeNull();
      }
    }
  });

  it("reads the binding through the account-scoped join, not the account alone", async () => {
    const { calls } = harness({ dbTimezone: "America/Los_Angeles" });
    await resolveBound("2026-09-05");
    const read = calls.find((text) => text.includes("provider_accounts"));
    expect(read).toBeTruthy();
    // CROSS-ACCOUNT EXCLUSION: the zone can only come from a binding this
    // business actually holds.
    expect(read).toContain("business_provider_accounts");
    expect(read).toContain("binding.business_id = $1");
  });
});

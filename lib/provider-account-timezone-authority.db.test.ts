/**
 * WHO MAY WRITE `provider_accounts.timezone`, AGAINST A REAL POSTGRESQL.
 *
 * ── ROUND 22, ITEM 1 ────────────────────────────────────────────────────────
 * The Meta partition authority resolves the provider-local day from the DB
 * binding rather than from the credential payload, and the recent-edit
 * authority judges every receipt against the day that binding defines. That
 * distinction was decorative: `ensureProviderAccountReferenceIds` upserted
 * `timezone = COALESCE(EXCLUDED.timezone, existing)`, so ANY ordinary
 * daily/raw/reference write moved the binding to whatever timezone the caller
 * happened to be carrying -- a credential profile, or a cached account
 * snapshot fetched days earlier.
 *
 * Three facts are proven here, because all three are facts about SQL semantics
 * rather than about code text:
 *
 *   1. an ordinary write POPULATES an absent binding (initial discovery must
 *      keep working -- a fix that only refused writes would break onboarding);
 *   2. an ordinary write cannot MOVE an existing binding;
 *   3. an explicit fresh-profile reconciliation can, and only it can.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  ensureProviderAccountReferenceBindings,
  ensureProviderAccountReferenceIds,
} from "@/lib/provider-account-reference-store";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const NEW_ACCOUNT = `act_tznew_${NONCE}`.slice(0, 60);
const BOUND_ACCOUNT = `act_tzbound_${NONCE}`.slice(0, 60);

async function timezoneOf(externalAccountId: string) {
  const sql = getDb();
  const rows = await sql<{ timezone: string | null }>`
    SELECT timezone FROM provider_accounts
     WHERE provider = 'meta' AND external_account_id = ${externalAccountId}
  `;
  return rows[0]?.timezone ?? null;
}

describe.skipIf(!SEAM)("the provider account timezone binding", () => {
  beforeAll(async () => {
    const sql = getDb();
    // One account already BOUND to Los Angeles, one that does not exist yet.
    await sql`
      INSERT INTO provider_accounts (provider, external_account_id, account_name, timezone)
      VALUES ('meta', ${BOUND_ACCOUNT}, 'bound seam', 'America/Los_Angeles')
    `;
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
    expect(await timezoneOf(NEW_ACCOUNT)).toBeNull();
  });

  afterAll(async () => {
    const sql = getDb();
    await sql`
      DELETE FROM provider_accounts
       WHERE provider = 'meta'
         AND external_account_id = ANY(${[NEW_ACCOUNT, BOUND_ACCOUNT]}::text[])
    `;
  });

  it("POPULATES an absent binding from an ordinary write", async () => {
    /*
      The case a blanket refusal would have broken. A brand-new account has no
      binding, and the first ordinary write is exactly how one comes to exist.
    */
    const bindings = await ensureProviderAccountReferenceBindings({
      provider: "meta",
      accounts: [
        { externalAccountId: NEW_ACCOUNT, accountName: "new", timezone: "Europe/Istanbul" },
      ],
    });
    expect(await timezoneOf(NEW_ACCOUNT)).toBe("Europe/Istanbul");
    // And the caller is told what the binding holds, so its rows can agree.
    expect(bindings.timezones.get(NEW_ACCOUNT)).toBe("Europe/Istanbul");
    expect(bindings.refIds.get(NEW_ACCOUNT)).toBeTruthy();
  });

  it("REFUSES to move an existing binding from an ordinary write", async () => {
    /*
      The defect itself. A core sync carrying `Europe/Istanbul` used to relabel
      an account bound to `America/Los_Angeles`, and every provider-local day
      computed afterwards was the credential payload's.
    */
    const bindings = await ensureProviderAccountReferenceBindings({
      provider: "meta",
      accounts: [
        { externalAccountId: BOUND_ACCOUNT, accountName: "bound", timezone: "Europe/Istanbul" },
      ],
    });
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
    /*
      And the value handed BACK is the binding's, not the caller's. This is what
      makes the row stamped by the writer agree with the day authority, instead
      of merely leaving the binding alone while writing the other calendar into
      every daily row.
    */
    expect(bindings.timezones.get(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
  });

  it("REFUSES through the id-only helper too, which has no authority argument", async () => {
    // The wrapper most callers use cannot ask for the authority at all, so a
    // new call site cannot acquire it by accident.
    await ensureProviderAccountReferenceIds({
      provider: "meta",
      accounts: [
        { externalAccountId: BOUND_ACCOUNT, accountName: "bound", timezone: "Asia/Tokyo" },
      ],
    });
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
  });

  it("APPLIES a real change through an explicit fresh-profile reconciliation", async () => {
    /*
      The other half of the contract, and the reason this is not simply a lock.
      Meta accounts DO change timezone, and when a fresh provider profile says
      so the binding must follow -- through the path that carries provenance and
      has already passed its generation compare-and-set.
    */
    await ensureProviderAccountReferenceBindings({
      provider: "meta",
      accounts: [
        { externalAccountId: BOUND_ACCOUNT, accountName: "bound", timezone: "Europe/Istanbul" },
      ],
      timezoneAuthority: "reconcile",
    });
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("Europe/Istanbul");

    // Restored the same way, which also shows the reconcile path is not
    // one-directional.
    await ensureProviderAccountReferenceBindings({
      provider: "meta",
      accounts: [
        {
          externalAccountId: BOUND_ACCOUNT,
          accountName: "bound",
          timezone: "America/Los_Angeles",
        },
      ],
      timezoneAuthority: "reconcile",
    });
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
  });

  it("leaves a binding alone when the fresh profile carries no timezone", async () => {
    // `COALESCE(EXCLUDED.timezone, existing)` on the reconcile arm: a profile
    // that simply omits the field is not an instruction to forget the binding.
    await ensureProviderAccountReferenceBindings({
      provider: "meta",
      accounts: [{ externalAccountId: BOUND_ACCOUNT, accountName: "bound", timezone: null }],
      timezoneAuthority: "reconcile",
    });
    expect(await timezoneOf(BOUND_ACCOUNT)).toBe("America/Los_Angeles");
  });
});

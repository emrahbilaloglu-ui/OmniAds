import { Client } from "pg";

import {
  BusinessCommercialSnapshotConflictError,
  businessCommercialSnapshotRevision,
  getBusinessCommercialTruthSnapshot,
  reconfirmBusinessTargetPack,
  upsertBusinessCommercialTruthSnapshot,
} from "@/lib/business-commercial";
import { resetDbClientCache } from "@/lib/db";
import {
  createEmptyBusinessCommercialTruthSnapshot,
  createEmptyCountryEconomicsRow,
  createEmptyOperatingConstraints,
  createEmptyPromoCalendarEvent,
  createEmptyTargetPack,
  type BusinessCommercialTruthSnapshot,
} from "@/src/types/business-commercial";

function assertEphemeralDatabase() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1") {
    throw new Error("Refusing to run outside the ephemeral migration seam.");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  const port = Number(parsed.port || "5432");
  if (parsed.hostname !== "127.0.0.1" || port === 15432 || port === 5432) {
    throw new Error("Refusing to run against a non-ephemeral PostgreSQL port.");
  }
  return databaseUrl;
}

function candidateSnapshot(
  businessId: string,
  marker: "A" | "B" | "FAIL",
): BusinessCommercialTruthSnapshot {
  const snapshot = createEmptyBusinessCommercialTruthSnapshot(businessId);
  return {
    ...snapshot,
    targetPack: {
      ...createEmptyTargetPack(),
      targetRoas: marker === "A" ? 3.1 : marker === "B" ? 4.2 : 5.3,
      breakEvenRoas: 1.8,
      sourceLabel: `commercial_seam_${marker}`,
    },
    countryEconomics: [
      {
        ...createEmptyCountryEconomicsRow(),
        countryCode: marker === "A" ? "US" : marker === "B" ? "GB" : "CA",
        notes: marker,
        sourceLabel: `commercial_seam_${marker}`,
      },
    ],
    promoCalendar: [
      {
        ...createEmptyPromoCalendarEvent(),
        eventId: `promo_${marker}`,
        title: marker === "FAIL" ? "__COMMERCIAL_SEAM_FORCE_FAILURE__" : marker,
        startDate: "2026-07-14",
        endDate: "2026-07-15",
        sourceLabel: `commercial_seam_${marker}`,
      },
    ],
    operatingConstraints: {
      ...createEmptyOperatingConstraints(),
      landingPageConcern: marker,
      sourceLabel: `commercial_seam_${marker}`,
    },
    calibrationProfiles: [],
  };
}

async function main() {
  const databaseUrl = assertEphemeralDatabase();
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const user = await admin.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Commercial seam', 'commercial-seam@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("Could not create commercial seam user.");
    const business = await admin.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Commercial seam', $1::uuid)
       RETURNING id::text AS id`,
      [userId],
    );
    const businessId = business.rows[0]?.id;
    if (!businessId)
      throw new Error("Could not create commercial seam business.");

    const initial = await getBusinessCommercialTruthSnapshot(businessId);
    const initialRevision = businessCommercialSnapshotRevision(initial);
    const writes = await Promise.allSettled(
      (["A", "B"] as const).map((marker) =>
        upsertBusinessCommercialTruthSnapshot({
          businessId,
          updatedByUserId: userId,
          snapshot: candidateSnapshot(businessId, marker),
          expectedRevision: initialRevision,
        }),
      ),
    );
    const fulfilled = writes.filter(
      (
        result,
      ): result is PromiseFulfilledResult<BusinessCommercialTruthSnapshot> =>
        result.status === "fulfilled",
    );
    const rejected = writes.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (
      fulfilled.length !== 1 ||
      rejected.length !== 1 ||
      !(rejected[0]?.reason instanceof BusinessCommercialSnapshotConflictError)
    ) {
      throw new Error(
        "Concurrent commercial writes did not resolve one-success/one-conflict.",
      );
    }

    const winner = fulfilled[0]!.value;
    let current = await getBusinessCommercialTruthSnapshot(businessId);
    if (
      current.targetPack?.targetRoas !== winner.targetPack?.targetRoas ||
      current.countryEconomics[0]?.countryCode !==
        winner.countryEconomics[0]?.countryCode ||
      current.promoCalendar[0]?.eventId !== winner.promoCalendar[0]?.eventId ||
      current.operatingConstraints?.landingPageConcern !==
        winner.operatingConstraints?.landingPageConcern
    ) {
      throw new Error(
        "Concurrent writes produced a hybrid commercial snapshot.",
      );
    }

    const raceUpdatedAt = current.targetPack?.updatedAt;
    if (!raceUpdatedAt) {
      throw new Error("Concurrent commercial winner has no version timestamp.");
    }
    const raceRevision = businessCommercialSnapshotRevision(current);
    const replacementMarker =
      current.targetPack?.targetRoas === 3.1 ? "B" : "A";
    const historyBeforeRace = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM business_target_pack_history WHERE business_id = $1",
      [businessId],
    );
    const [reconfirmationRace, replacementRace] = await Promise.allSettled([
      reconfirmBusinessTargetPack({
        businessId,
        updatedByUserId: userId,
        expectedUpdatedAt: raceUpdatedAt,
      }),
      upsertBusinessCommercialTruthSnapshot({
        businessId,
        updatedByUserId: userId,
        snapshot: candidateSnapshot(businessId, replacementMarker),
        expectedRevision: raceRevision,
      }),
    ]);
    if (reconfirmationRace.status === "rejected") {
      throw new Error(
        `Concurrent target reconfirmation failed unexpectedly: ${String(reconfirmationRace.reason)}`,
      );
    }
    const reconfirmed = reconfirmationRace.value.status === "reconfirmed";
    const reconfirmationConflicted =
      reconfirmationRace.value.status === "conflict";
    const replacementSucceeded = replacementRace.status === "fulfilled";
    const replacementConflicted =
      replacementRace.status === "rejected" &&
      replacementRace.reason instanceof BusinessCommercialSnapshotConflictError;
    if (!(
      (reconfirmed && replacementConflicted) ||
      (reconfirmationConflicted && replacementSucceeded)
    )) {
      throw new Error(
        "Concurrent reconfirm/replace did not resolve exactly one mutation and one conflict.",
      );
    }
    current = await getBusinessCommercialTruthSnapshot(businessId);
    const historyAfterRace = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM business_target_pack_history WHERE business_id = $1",
      [businessId],
    );
    if (
      Number(historyAfterRace.rows[0]?.count ?? 0) !==
      Number(historyBeforeRace.rows[0]?.count ?? 0) + 1
    ) {
      throw new Error(
        "Concurrent reconfirm/replace did not persist exactly one history version.",
      );
    }

    await admin.query(`
      CREATE OR REPLACE FUNCTION commercial_seam_force_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = '__COMMERCIAL_SEAM_FORCE_FAILURE__' THEN
          RAISE EXCEPTION 'forced commercial seam failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await admin.query(`
      CREATE TRIGGER commercial_seam_force_failure_trigger
      BEFORE INSERT OR UPDATE ON business_promo_calendar_events
      FOR EACH ROW EXECUTE FUNCTION commercial_seam_force_failure()
    `);
    const beforeFailureRevision = businessCommercialSnapshotRevision(current);
    const historyBefore = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM business_target_pack_history WHERE business_id = $1",
      [businessId],
    );
    await upsertBusinessCommercialTruthSnapshot({
      businessId,
      updatedByUserId: userId,
      snapshot: candidateSnapshot(businessId, "FAIL"),
      expectedRevision: beforeFailureRevision,
    }).then(
      () => {
        throw new Error("Forced mid-write failure unexpectedly committed.");
      },
      () => undefined,
    );
    const afterFailure = await getBusinessCommercialTruthSnapshot(businessId);
    const historyAfter = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM business_target_pack_history WHERE business_id = $1",
      [businessId],
    );
    if (
      businessCommercialSnapshotRevision(afterFailure) !==
        beforeFailureRevision ||
      historyAfter.rows[0]?.count !== historyBefore.rows[0]?.count
    ) {
      throw new Error(
        "Mid-write failure left partial commercial state or history.",
      );
    }

    console.log(
      "[business-commercial-seam] PASS: one advisory lock serializes replacement/reconfirmation CAS and mid-write failures roll back atomically.",
    );
  } finally {
    await admin
      .query(
        "DROP TRIGGER IF EXISTS commercial_seam_force_failure_trigger ON business_promo_calendar_events",
      )
      .catch(() => undefined);
    await admin
      .query("DROP FUNCTION IF EXISTS commercial_seam_force_failure()")
      .catch(() => undefined);
    await admin.end();
    resetDbClientCache();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

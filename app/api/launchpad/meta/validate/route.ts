import { NextRequest, NextResponse } from "next/server";
import { buildValidationPreflightDisclosure } from "@/lib/launchpad/validation-preflight-disclosure";
import {
  metaLaunchAccountBlockerHttpStatus,
  readMetaLaunchAccountChecks,
  resolveAssignedMetaLaunchAccount,
  validateMetaAddToExistingRequest,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";

type ValidateBody = {
  businessId?: string;
  providerAccountId?: string;
  payload?: unknown;
  /**
   * Advisory batch: many drafts, one account read.
   *
   * The Drafts table draws a Validation column on every row, and validating
   * them one request at a time re-read the account's billing status and pixel
   * list from the Graph API per draft — about a hundred provider calls for one
   * page of fifty. Batched, that is two, and the per-draft shape checks are
   * pure. `payload` stays the single-draft form every write path uses.
   */
  payloads?: Array<{ key?: unknown; payload?: unknown }>;
};

function payloadMode(payload: unknown): string {
  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "mode" in payload
    ? String((payload as Record<string, unknown>).mode)
    : "new_campaign";
}

/** One page of drafts. The store itself returns at most 50. */
const MAX_BATCH_PAYLOADS = 50;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await readJsonBody<ValidateBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }

  try {
    if (Array.isArray(body?.payloads)) {
      const batch = body.payloads.slice(0, MAX_BATCH_PAYLOADS);
      const accountChecks = await readMetaLaunchAccountChecks({
        businessId: access.businessId,
        providerAccountId: account.providerAccountId,
      });
      const results = [];
      for (const entry of batch) {
        const mode = payloadMode(entry?.payload);
        const result =
          mode === "add_to_existing"
            ? await validateMetaAddToExistingRequest({
                businessId: access.businessId,
                providerAccountId: account.providerAccountId,
                payload: entry?.payload,
              })
            : await validateMetaLaunchRequest({
                businessId: access.businessId,
                providerAccountId: account.providerAccountId,
                payload: entry?.payload,
                accountChecks,
              });
        results.push({
          key: typeof entry?.key === "string" ? entry.key : null,
          ok: result.ok,
          blockers: result.blockers,
          warnings: result.warnings,
        });
      }
      return NextResponse.json(
        {
          ok: true,
          results,
          // The batch shares one account-level read, so it shares one
          // disclosure. Per-entry copies would imply per-entry freshness.
          preflight: buildValidationPreflightDisclosure({
            checkedAt: new Date().toISOString(),
            providerReads: ["billing_status", "pixels", "target_account"],
          }),
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const singleMode = payloadMode(body?.payload);
    const result =
      singleMode === "add_to_existing"
          ? await validateMetaAddToExistingRequest({
              businessId: access.businessId,
              providerAccountId: account.providerAccountId,
              payload: body?.payload,
            })
          : await validateMetaLaunchRequest({
              businessId: access.businessId,
              providerAccountId: account.providerAccountId,
              payload: body?.payload,
          });
    return NextResponse.json({
      ok: result.ok,
      blockers: result.blockers,
      warnings: result.warnings,
      pixels: "pixels" in result ? result.pixels : [],
      target: "target" in result ? result.target : null,
      targets: "targets" in result ? result.targets : [],
      /*
       * §10 step 10. A green validation used to read as "this launch is
       * cleared", and it is not: it rests on live provider state that moves,
       * and it carries no creative-identity proof — that check runs at
       * execution time, immediately before the first create.
       *
       * The disclosure names both directions on purpose. Saying only "this did
       * not contact Meta" would be false, because validation does read billing
       * and pixels, and a false reassurance is worse than none.
       */
      preflight: buildValidationPreflightDisclosure({
        checkedAt: new Date().toISOString(),
        providerReads: ["billing_status", "pixels", "target_account"],
      }),
    });
  } catch (error) {
    return jsonError(500, "validation_failed", sanitizeErrorMessage(error));
  }
}

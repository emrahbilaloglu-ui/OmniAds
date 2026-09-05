/**
 * Compatibility shim for `/platforms/meta` (WP-27A).
 *
 * The legacy body is preserved verbatim at `./legacy-page` and mounted
 * unchanged whenever the canonical UI is not being presented — which is what
 * makes `ZERO_BASE_UI_MODE=off` a rollback rather than a redeploy. Every other
 * decision, and the ordering that keeps it safe, lives in one module.
 *
 * ## Why this shim is not three lines any more
 *
 * The body accepts the two capability props the canonical route computes
 * (`app/c/[businessId]/meta/decisions/page.tsx`), and the generic shim mounts
 * legacy bodies with their props untouched. So on this route family both
 * arrived `undefined`, the body applied its fail-closed reading, and the rail —
 * which links here — showed a Decisions screen with no manual action and no
 * workflow controls while the canonical URL showed both. That asymmetry was
 * the capability being spelled twice rather than a decision anybody made.
 *
 * The wrapper supplies the same server reading. It is env-level capability
 * only; what a viewer may actually do to a specific business is still decided
 * per request by `resolveMetaWriteCapability` and `getMetaWriteBlockState`.
 *
 * @see lib/zero-base/compatibility-page.tsx
 */
import { compatibilityPage } from "@/lib/zero-base/compatibility-page";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { isMutationUiEnabled } from "@/lib/zero-base/meta/mutation-ceremony";
import LegacyBody from "./legacy-page";

// The shim reads the session before deciding, so this segment is never static.
export const dynamic = "force-dynamic";

function MetaLegacyBodyWithCapability(props: Record<string, unknown>) {
  return (
    <LegacyBody
      {...props}
      decisionWorkflowUiEnabled={readMetaReleaseGates().decisionWorkflowUi}
      mutationUiEnabled={isMutationUiEnabled()}
    />
  );
}

export default compatibilityPage(
  "/platforms/meta",
  MetaLegacyBodyWithCapability as never,
);

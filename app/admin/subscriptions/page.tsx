/**
 * Compatibility shim for `/admin/subscriptions` (WP-27A).
 *
 * The legacy body is preserved verbatim at `./legacy-page` and mounted
 * unchanged whenever the canonical UI is not being presented — which is what
 * makes `ZERO_BASE_UI_MODE=off` a rollback rather than a redeploy. Every other
 * decision, and the ordering that keeps it safe, lives in one module.
 *
 * @see lib/zero-base/compatibility-page.tsx
 */
import { compatibilityPage } from "@/lib/zero-base/compatibility-page";
import LegacyBody from "./legacy-page";

// The shim reads the session before deciding, so this segment is never static.
export const dynamic = "force-dynamic";

export default compatibilityPage("/admin/subscriptions", LegacyBody);

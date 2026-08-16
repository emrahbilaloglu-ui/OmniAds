import { redirect } from "next/navigation";

// v2 gives Google Ads routed surfaces; this legacy sub-route folds into the
// plan & activity screen that now owns its content.
export default function GoogleLegacyRedirect() {
  redirect("/platforms/google/plan");
}

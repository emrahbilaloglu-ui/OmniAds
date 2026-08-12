import { redirect } from "next/navigation";

// The Google Ads intelligence dashboard is a single self-contained workspace; its
// Ads view is an internal panel, so this legacy sub-route folds back into it.
export default function GoogleAdsRedirect() {
  redirect("/platforms/google");
}

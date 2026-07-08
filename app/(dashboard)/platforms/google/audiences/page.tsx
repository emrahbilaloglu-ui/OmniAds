import { redirect } from "next/navigation";

// The Google Ads intelligence dashboard is a single self-contained workspace; its
// audience intelligence lives inside it, so this legacy sub-route folds back in.
export default function GoogleAudiencesRedirect() {
  redirect("/platforms/google");
}

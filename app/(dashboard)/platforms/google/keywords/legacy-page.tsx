import { redirect } from "next/navigation";

// The Google Ads intelligence dashboard is a single self-contained workspace; its
// keyword/search intelligence lives inside it, so this legacy sub-route folds back in.
export default function GoogleKeywordsRedirect() {
  redirect("/platforms/google");
}

import { redirect } from "next/navigation";

// Google Ads has no launch/write surface built yet, and the intelligence dashboard is
// the single live Google workspace, so this legacy sub-route folds back into it rather
// than advertising a "coming soon" surface that isn't wired.
export default function GoogleLaunchpadRedirect() {
  redirect("/platforms/google");
}

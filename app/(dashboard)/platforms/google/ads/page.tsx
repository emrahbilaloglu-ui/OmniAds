import { ComingSoonState } from "@/components/states/ComingSoonState";

export default function GoogleAdsPage() {
  return (
    <ComingSoonState
      platformId="google"
      status="beta"
      title="Google Ads workspace is in beta"
      description="Ads management will land here after the shell migration. The current PR only wires the route and navigation context."
    />
  );
}

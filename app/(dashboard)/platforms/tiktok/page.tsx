import { ComingSoonState } from "@/components/states/ComingSoonState";

// TikTok has no live integration (no OAuth, sync, or API routes) — the only data source
// is demo/fabricated. Rendering it as a "server-backed table" would be dishonest, so the
// route shows the honest not-built boundary until a real TikTok backend exists.
export default function TikTokPage() {
  return <ComingSoonState platformId="tiktok" />;
}

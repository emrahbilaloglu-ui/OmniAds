import { ComingSoonState } from "@/components/states/ComingSoonState";

// Snapchat has no live integration (no OAuth, sync, or API routes) — the only data source
// is demo/fabricated. Rendering it as a "server-backed table" would be dishonest, so the
// route shows the honest not-built boundary until a real Snapchat backend exists.
export default function SnapchatPage() {
  return <ComingSoonState platformId="snapchat" />;
}

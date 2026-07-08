import { ComingSoonState } from "@/components/states/ComingSoonState";

// Pinterest has no live integration (no OAuth, sync, or API routes) — the only data source
// is demo/fabricated. Rendering it as a "server-backed table" would be dishonest, so the
// route shows the honest not-built boundary until a real Pinterest backend exists.
export default function PinterestPage() {
  return <ComingSoonState platformId="pinterest" />;
}

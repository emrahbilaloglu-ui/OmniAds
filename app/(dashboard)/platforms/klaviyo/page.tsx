"use client";

import { KlaviyoClient } from "@/components/klaviyo/klaviyo-client";

/**
 * The design's Klaviyo section is a bare `<section>`: no max-width, no padding
 * and no font override, so it inherits the shell page frame like every other v2
 * screen. The old `ad-workspace-page` wrapper clamped it to 1060px and forced
 * IBM Plex Sans 13px, which nothing else on the dashboard does.
 */
export default function KlaviyoPage() {
  return <KlaviyoClient />;
}

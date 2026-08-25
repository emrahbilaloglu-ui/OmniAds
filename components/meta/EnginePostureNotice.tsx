/**
 * Which of the five Engine V3 postures a creative surface is in, stated.
 *
 * Presentational only. It decides nothing: the posture arrives already resolved
 * from the server, and every word it prints comes from `postureView`, so the
 * screen and the resolver cannot disagree about what "shadow mode" means.
 *
 * ## Why `serving` is the quiet one
 *
 * Four of the five postures change what an operator may believe about the
 * decisions below, and each of those says so. `serving` is the state the
 * surface is supposed to be in, and a banner announcing that everything is
 * normal is noise that teaches people to stop reading banners. It still emits
 * its marker, so a gate can tell "serving" from "we never resolved a posture".
 *
 * ## Why the marker is an attribute
 *
 * `data-engine-posture` is the only way to ask a rendered surface which posture
 * it believes it is in. Without it, a shadow surface and a serving surface are
 * distinguishable only by prose, which is exactly the ambiguity that let shadow
 * decisions be read as authority.
 */
import { postureView, type EnginePosture } from "@/lib/zero-base/creative/engine-posture";

/** The four postures that change what the operator may believe. */
const ANNOUNCED: readonly EnginePosture[] = [
  "unavailable",
  "disabled",
  "shadow_only",
  "hidden",
];

export function EnginePostureNotice({
  posture,
  surfaceId,
}: {
  posture: EnginePosture;
  surfaceId: string;
}) {
  const view = postureView(posture);
  const announced = ANNOUNCED.includes(posture);

  return (
    <div
      data-engine-posture={posture}
      data-engine-surface={surfaceId}
      /* The claim a row-level action affordance must never contradict. */
      data-decisions-are-authority={view.decisionsAreAuthority ? "" : undefined}
      style={
        announced
          ? {
              display: "grid",
              gap: 4,
              margin: "0 0 12px",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid var(--adv-border, #e4e8f0)",
              background: "var(--adv-fill, #f7f9fc)",
              fontSize: 12,
              lineHeight: "18px",
              color: "var(--adv-ink-2, #45526b)",
            }
          : undefined
      }
    >
      {announced ? (
        <p role="status" style={{ margin: 0 }}>
          <strong style={{ fontWeight: 600 }}>{view.label}</strong>
          {` — ${view.explanation}`}
        </p>
      ) : null}
    </div>
  );
}

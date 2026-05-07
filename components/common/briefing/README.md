# Shared Briefing Components

`LevelChip` renders the shared scope marker for account, campaign, adset, and creative decisions. It preserves the Meta prototype `scopeChip` class contract and should receive only a `DecisionLevel`; surface-specific labels stay inside the component.

`DecisionLabelChip` is the single chip renderer for briefing decision labels. It reads all label text and palette classes from `decision-label-palette.ts`, supports creative and Meta source palettes, and exposes an unstyled mode only for legacy wrappers that must keep pre-existing markup stable.

`ConfidencePill` renders the compact tabular confidence percent, while `confidenceClass` centralizes the high/mid/low visual-weight thresholds used by briefing cards. Consumers should use the util for card border, thumbnail, text weight, and primary-button styling instead of reimplementing those thresholds.

`LaneHeader` renders the color-bar lane heading for Action, Watching, Healthy, and Audience lanes. The creative variant matches `briefing.js`; the Meta variant matches `meta-briefing.js`; callers provide counts, subtitles, collapsed state, and optional toggle handling.

`EvidenceAccordion` owns the shared six-section evidence accordion structure. Callers pass section content for Decision, Inputs, Funnel, Engine trail, Operator response, and Provenance; variants preserve the creative, Meta, and legacy section chrome while keeping accordion semantics and `aria-expanded` state in one place.

`TrackingBlockerBanner` renders the tracking anomaly blocker copy and actions. It is informational by default, can expose View details and dismiss handlers, and should be shown before destructive cut workflows when tracking quality is degraded.

`TrackingConfirmModal` is the secondary confirmation gate for cuts or other destructive actions during tracking anomalies. The primary button label is parameterized so single-card and bulk actions can use exact copy while sharing the same degraded-tracking warning.

`CompareDrawer` renders the bottom comparison drawer for two to five decision items. It owns thumbnail, chip, trend, and outlier highlighting layout while accepting a metric list and bottom action slot so each surface can keep its own action bar.

`LaunchpadOverlay` renders the Launchpad bridge for `promote`, `demote`, `fresh_test`, `rebuild`, `duplicate`, and `apply_bid`. The default presentation is the source modal overlay; the panel presentation exists only for the dev playground so every mode can be reviewed side by side.

`DeferChip` renders the exact deferred-state copy, including `Reappears tomorrow 9am · Undo`. `useDeferState()` hydrates from `/api/triage/state`, writes optimistic defer/undefer events to `/api/triage/event`, and exposes `deferredCount` for lane summaries.

`PulseStrip` is a slot-based layout shell for the sticky account pulse. It does not compute KPI content; surfaces provide left, center, right, jump-nav, and KPI-band slots so the shared layer owns only the prototype spacing and sticky chrome.

`BulkToolbar` renders creative and Meta bulk-action toolbars. It hides at count zero, emits selected actions through callbacks, and routes destructive actions through `TrackingConfirmModal` first when `trackingBlocked` is true.

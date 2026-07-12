# Meta Decisions Triage Board Rationale

Date: 2026-07-10
Route: `/platforms/meta`

## Review

The rejected implementation was accurate but product-poor. Ten aligned columns made every lane read like an export, while the date controls, status controls, filter toolbar, readiness context, and morning brief delayed the first decision. Unavailable trend and delta fields also consumed permanent width as honest but low-value dashes. Treating creatives as another row compounded the problem: it ignored the asset as the natural unit of inspection.

The old layout was especially weak at account scale. More rows increased vertical sprawl, while wide screens added columns rather than helping the operator move between account structure, decision, and evidence.

## Direction

The implemented direction is a triage board with a bounded scope rail:

- Keep the five server-owned lanes. They communicate state without inventing a cross-engine rank.
- Use a campaign/ad-set scope rail for navigation, not another business selector. The globally selected business remains authoritative.
- Render actionable and watching recommendations as two-column evidence cards. Each card keeps a fixed Spend anchor, server-owned action authority, confidence, concise reason, and one-click evidence access.
- Limit the first render to six decision cards or twelve quiet rows, with an explicit `Showing N of M` receipt and wired reveal control.
- Render Healthy and Archive as compact quiet lists. These lanes need scan density, not action-card emphasis.
- Keep Non-sales informational and read-first. Upper-funnel findings remain clearly distinct from purchase decisions.
- Give Creative Calls a separate lens, label groups, and compact asset cards. Only twelve render initially. The scope rail becomes an explicit account-wide contract notice because the creative engine does not publish campaign/ad-set parent mapping.
- Keep every existing write path, evidence drawer, compare/bulk behavior, bid flow, deferred state, posture banner, and deep link. The UI still never computes buyer action.

This is deliberately a hybrid rather than a pure card wall or spreadsheet. Actionable work earns richer cards; high-volume low-urgency states retain compact rows. Wide screens spend space on structure plus two decision columns, while mobile stays read-only and evidence-first.

## Data Honesty

- Spend is labeled `Spend`; there is no invented money-at-stake metric.
- Missing metrics render as `-` in the visual contract, implemented with the existing em-dash glyph used by the application.
- Counts remain withheld while the workspace is loading or unavailable.
- Creative preview wells render only when a real preview URL is present. Current preview-less records use a compact unavailable state, never a fabricated image.
- Creative sorting is fixed to spend because that is the implemented ranking. The UI does not offer sort choices that are not applied.
- Campaign/ad-set creative filtering is unavailable and explained until parent mappings exist.

## Fuller Creative Contract

A true visual gallery and hierarchy-aware creative drill-down require the creative engine response to add:

- `thumbnailUrl` or `previewUrl` with a stable expiry/refresh contract
- `assetType`, `aspectRatio`, and optional placement-safe crop metadata
- `campaignId`, `campaignName`, `adsetIds`, and `adsetNames`
- a stable asset deduplication key for one creative used by multiple ads
- optional placement list and delivery status if those are intended as filters

Until those fields exist, the UI must stay account-wide and preview-honest.

## Live Scale Check

The Grandmix demo account was inspected on 2026-07-10 with 7 Action Now, 22 Watching, 30 Non-sales, 1,071 Archive, and 203 actionable Creative Calls. The first viewport showed the highest-spend decision cards and explicit bounded receipts rather than rendering every record.

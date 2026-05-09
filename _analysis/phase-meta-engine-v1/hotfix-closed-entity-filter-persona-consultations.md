# Hotfix: Closed Entity Briefing Filter Persona Consultations

Timestamp: 2026-05-09

## Marcus — Operator UX

Question: Marcus, given the daily Meta briefing is polluted by paused, archived, deleted, and unknown entities, how should the default briefing scope behave for a five-minute operator triage?

Response: Default to Active only. Paused entities older than the immediate review window are not daily action candidates and bury the rows that can still spend today. Keep a short "Active + paused" mode for post-pause review, and reserve "All" for audit work.

Outcome: The default `status_filter` is `active`. A second chip, `active_plus_recent_paused`, includes only paused rows with a status-change timestamp within 24 hours. The `all` chip remains available for full-inventory review.

## Sam — Architecture

Question: Sam, should this be a UI-only filter or an API-owned briefing contract?

Response: The API must own the filter. Pulse aggregation, lane classification, and archive counts need the same denominator; if the UI computes this separately, the strip and lanes will drift again. Closed entities should live on a separate archive path with last-known metrics and no engine recommendation semantics.

Outcome: `lib/meta/briefing-filter.ts` is the shared contract. `/api/meta/account-pulse`, `/api/meta/lane-classify`, and `/api/creatives/briefing` all accept `status_filter` and filter before KPI or lane computation. The Meta page renders a minimal Archive section from the lane API payload rather than deriving closed rows client-side.

## R&D Extraction Handling

The Phase Meta R&D extraction remains unfiltered intentionally. Its job is academic audit coverage across the full inventory, including closed and unknown-status entities. The operator briefing endpoints now own the production daily-triage filter, so action density for the live surface should be measured from `status_filter=active` briefing responses rather than from the unfiltered R&D CSV denominator.

# Live Output Restoration Final

Last updated: 2026-04-24 by Codex

## 1. Branch / PR Status

- Branch: `feature/adsecute-creative-live-output-restoration`
- PR: open after validation in this pass
- Merge status: allowed after checks, because live Decision OS rows now flow

## 2. Root Cause Found

The prior live-firm zero-row result came from the audit helper using the wrong current-source path.

Specifically:

- the branch audit read current Decision OS rows through a warehouse-backed helper
- that helper depended on `meta_creative_daily`
- `meta_creative_daily` is currently empty for the live audited cohort
- the actual `/platforms/meta/creatives` Decision OS path reads live/persisted creative payloads and returns rows

This was a source-parity bug in the audit helper, not a Creative policy bug.

## 3. What Was Fixed

Helper-only restoration:

- switched the audit helper back to the actual `getCreativeDecisionOsForRange()` path
- removed the warehouse-backed Decision OS fallback from the helper
- made the helper request base URL explicit and local-runtime-safe
- added a localhost refresh guard for CLI audit execution so background snapshot warm requests do not recurse or fail the run

No product behavior changed.

## 4. Live Row Flow After Rerun

Current Decision OS rows now flow for all `8` readable live Meta businesses.

Per-business current Decision OS row counts:

- `company-01`: `50`
- `company-02`: `8`
- `company-03`: `16`
- `company-04`: `50`
- `company-05`: `56`
- `company-06`: `64`
- `company-07`: `35`
- `company-08`: `40`

Total current Decision OS creatives across the rerun: `319`

## 5. Live-Firm Segment Counts After Restoration

- `Scale`: `0`
- `Scale Review`: `0`
- `Protect`: `17`
- `Campaign Check`: `4`
- `Watch`: `47`
- `Refresh`: `24`
- `Test More`: `21`
- `Not Enough Data`: `138`
- `Not eligible for evaluation`: `68`
- `Retest`: `0`
- `Cut`: `0`

Businesses with zero current Decision OS rows: `0`

Businesses with zero `Scale`: `8`

Businesses with zero `Scale Review`: `8`

## 6. Restoration Verdict

Live output is restored.

What the rerun now proves:

- current readable businesses do produce current Decision OS rows
- segment distribution spans more than four meaningful labels
- the earlier live-firm blocker was upstream helper drift, not current row flow failure

What this rerun does not decide:

- whether zero live `Scale` / `Scale Review` is product-appropriate
- whether current label boundaries are trustworthy enough at live-firm level

Those are now valid follow-up review questions because rows are finally flowing.

## 7. Recommended Next Action

Run a fresh live-firm product review on the restored current-output cohort.

That review should judge actual segmentation quality, not empty-state behavior.

## 8. Whether Another Live-Firm Audit Is Needed

Yes, as a fresh substantive review.

Reason:

- the prior live-firm audit was blocked by helper/source mismatch
- the restored rerun now produces actual current rows and real segment counts
- the next review can finally evaluate the live product instead of an empty-state false alarm

## 9. Whether This Is Ready For Claude Live-Firm Review

Yes.

It is now ready for a fresh live-firm Claude review against the restored current-output path.

# Decisions → Creatives: representative historical acceptance (2026-09-23)

This is a point-in-time, read-only check of the candidate working tree, not a
claim about the deployed release. The global code changes have no
business-specific branches. Grandmix supplies a high-volume presentation
case; TheSwaf supplies a real source-gap control. The input window is
2026-08-25 through 2026-09-22, with the decision evaluated at
2026-09-22T23:59:59.999Z. `PGOPTIONS` forced read-only transactions.

| Check | Observed result |
| --- | --- |
| Grandmix decision and presentation | 2,517 ad decisions; 53 source-backed inventory items reached the presentation; 80 Briefing cards and classifications; 60 OS rows at limit 60. |
| Grandmix hard-action authority | Three held hard verdicts, zero authorized actions. Objective authority and D101 closed-day coverage were incomplete for all three. The presence gate passed, but hard-action authority was **not demonstrated**. |
| TheSwaf negative control | Campaign `120251964505870042` had 120 real ad-days in the window, 98 with spend and two on the target day. Its objective lacked decision authority at the target cutoff. Four simulated hard Cut verdicts remained unauthorized. The control passed. |
| Safety and persistence | Zero invariant violations and zero lane failures. The post-deploy gate was not met because the latest persisted Grandmix generation still used the older engine epoch. |

The report's `PRE_DEPLOY GATE PASSED` means source-backed decisions reached the
candidate presentation and the negative control failed closed. It does not
mean that a source-authorized Cut, Scale, or Refresh has been observed.
Historical config gaps cannot be filled with a current campaign value. The
candidate's numeric Meta config parser and raw-generation page selection
address two observed sync failure classes that delayed source publication;
their live effect requires same-SHA readback after release.

Reproduce the bounded check (the output path must be a new path outside the
repository):

```sh
TZ=UTC PGOPTIONS='-c default_transaction_read_only=on' \
  node --env-file-if-exists=.env.local --import tsx \
  scripts/creative-decision-center/meta-decisions-creatives-acceptance.ts \
  --business 5dbc7147-f051-4681-a4d6-20617170074f \
  --negative-control 172d0ab8-495b-4679-a4c6-ffa404c389d3 \
  --negative-control-campaign 120251964505870042 \
  --chain 1 --out /tmp/meta-creatives-acceptance-new.json --write 1
```

The first run was on a dirty working tree, so its code identity was the
working-tree module hashes, not HEAD. A clean commit and a fresh
`--require-clean` run are required before tying these observations to a
release SHA. No production decision was regenerated or published by this
simulation.

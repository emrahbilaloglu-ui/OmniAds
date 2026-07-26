#!/usr/bin/env bash
set -euo pipefail

# Superseded entry point for the cutover harness.
#
# WHY THIS IS NOW A FORWARDER
#
# This file used to BE the harness, and it drove the real cutover script against
# stub hosts whose ssh answered every query with a canned string: `*string_agg*`
# printed `abc123`, `*meta_raw_snapshots*` printed `10|20|30`, `*lease_owner*`
# printed whatever STUB_LEASES was set to. That is enough to show the phase graph
# is traversable and nothing more. It cannot show that the fingerprint SQL parses,
# that the schema-conditional selection predicate produces the same digest before
# and after the migration adds `is_selected`, that a full pg_dump can be restored
# into a scratch database, or that quiescence notices a live application backend —
# and a harness that reports PASS for all of those without testing any of them is
# worse than no harness, because it is believed.
#
# `scripts/cutover-real-postgres-harness.sh` replaces it with the same phase
# traversal against a REAL ephemeral PostgreSQL and a split app-host/DB-host
# command surface. This name is kept, and forwards, so anything that still
# invokes the old path runs the authoritative harness instead of silently
# running nothing.

exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cutover-real-postgres-harness.sh" "$@"

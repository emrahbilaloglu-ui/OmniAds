# Operator cutover session — ordered procedure

Target `8750774f0583bd239eb83f387cfd3fbca7d58c81`. Runner
`/var/lib/adsecute-cutover-runner/8750774f0583bd239eb83f387cfd3fbca7d58c81-4a42304e90ae`,
wrapper `4a42304e90aeac6b5401d564284197f569fdb22d179f4cdcc343b660882d305d`.

Nothing below runs until the user authorizes credential forwarding (Step 1).
Every step is one command, run one at a time, and read before the next is chosen.

| # | Command | Forwards credential? | Mutates production? |
|---|---|---|---|
| 1 | *authorization gate — ask, do not run* | — | — |
| 2 | `scripts/operator/run.sh verify` | yes | **no** |
| 3 | `scripts/operator/lanes.sh disable` | **no** | yes, reversible |
| 4 | `scripts/operator/run.sh phase preflight` | yes | yes (opens the one epoch) |
| 5 | `scripts/operator/run.sh phase quiesce` | yes | yes — **site goes down here** |
| 6 | `scripts/operator/run.sh phase fingerprint-pre` | yes | yes |
| 7 | `scripts/operator/run.sh phase migrate` | yes | yes |
| 8 | `scripts/operator/run.sh phase verify-contract` | yes | yes (expect 15/15) |
| 9 | `scripts/operator/run.sh phase fingerprint-post` | yes | yes |
| 10 | `scripts/operator/run.sh phase deploy-disabled` | yes | yes |
| 11 | `scripts/operator/run.sh phase enable` | yes | yes |
| 12 | `scripts/operator/run.sh phase resume-scheduler` | yes | yes — **site back up** |
| 13 | rotate `CRON_SECRET` (below) | no | yes |

Abort path at any point: `scripts/operator/lanes.sh restore`, then the wrapper's
`emergency-disable` if a phase past `quiesce` has run. Restore old production
first, then stop — never start a second epoch, never retry on a guess.

## What each guard is for

`run.sh` starts its own `ssh-agent`, loads only `~/.ssh/id_ed25519`, asserts
the agent holds **exactly one** identity and that it is
`SHA256:VqHQoYUYI4aIj0KnYvWZEUp/BHAMFkuBksYRJDD+KQ4`, and forwards *that* agent —
not the login agent, whose contents could widen at any time from an unrelated
`ssh-add`. Forwarding is `-o ForwardAgent=yes` with `ControlMaster=no` and
`ControlPath=none`, so no multiplexed socket can outlive the process. `-A` is
deliberately not used.

`ssh-add -c` (confirm on every agent use) is deliberately **not** enabled: an
unattended multi-hour phase must not fail on a prompt nobody is at the keyboard
for. The bound on the credential is the one-key agent plus proven teardown, not
per-use consent.

`host-verify.sh` / `host-phase.sh` re-assert the same fingerprint **on the app
host**, then re-derive every runner-package hash from the bytes on disk — the
same gates `cutover_runner_verify_package` applies in CI. Driving the wrapper
from a shell must not mean weaker checks than CI used. Any pin arriving empty is
a hard stop, because a check comparing against `""` passes vacuously.

The single-epoch rule is enforced explicitly: `preflight` refuses if a state
record already carries this runner's `wrapper_sha256` (a second `preflight` would
open a second epoch and silently abandon the first), and every later phase
refuses unless it does.

Phase output goes to a host-side 0600 log; only a bounded 40-line tail returns.
Streaming full phase output — which includes container logs — is what killed the
SSH channel with status 255 on all four CI attempts.

Redaction **drops whole lines** and never substitutes. A `s/Bearer[^ ]*/…/`
filter earlier in this engagement printed a live token in full because the token
sat after a space. Crontab and env bodies are never read into output at all —
only hashes, counts and key names.

Every `ssh` invocation in this procedure sets `StrictHostKeyChecking=yes`
explicitly — none relies on a compiled-in default, and `accept-new`, `no` and
`ask` appear nowhere. Both hosts' keys are already in `known_hosts`, so this
costs nothing and removes the one case `accept-new` would have waved through: a
first-contact key trusted silently because nobody was watching.

One hop is **not** covered by that, and cannot be: the wrapper's own app-host →
DB-host connections are built by its internal `db_ssh_opts`, which sets no
host-key policy. Changing it would mean editing the release-pinned wrapper and
breaking the `4a42304e…` hash every gate verifies, or mutating the app host's SSH
config. Neither is acceptable, so it stays as-is. In effect it still fails
closed: `db_ssh_opts` sets `BatchMode=yes`, and under BatchMode the default `ask`
cannot prompt, so an unknown key errors out and a changed key is refused outright.

**Defect found on the first real run (2026-07-30, verify), now fixed.** The
agent was started inside the `{ … } | tee` block — a pipeline, so a subshell —
and `AGENT_PID` therefore never reached `cleanup` in the parent. `cleanup` took
its "no agent was established" branch: it printed `nothing-forwarded`, skipped
`host-teardown.sh` entirely, and left the agent process alive. `local_agent_pid_alive=NO`
was a vacuous pass, not a proof. The agent start now happens in the parent shell
before the pipeline, and a contradiction guard turns "a forwarded socket was
recorded but I hold no handle" into a loud `unprovable-treat-as-live` rather than
a clean-looking exit. Teardown for that run was completed and proven by hand.

`host-teardown.sh` runs over a **separate non-forwarding** connection after the
session ends (on success, failure, interrupt or timeout alike) and proves: the
forwarded socket is gone, its per-session directory is gone, no stray forwarded
sockets remain, no wrapper or dump process is orphaned, and the wrapper's
`ControlPersist` master to the DB host is explicitly closed with `ssh -O exit`
rather than left to expire — that master stays usable for up to 900 s after the
agent that authenticated it is gone. If teardown cannot be proven, the run says
so and tells the operator to treat the credential as live.

## Step 13 — mandatory `CRON_SECRET` rotation (after Step 12, never before)

The live cron bearer token was exposed in the diagnostic transcript on
2026-07-30. It is `CRON_SECRET` in `.env.production`, checked by
[route.ts:209](app/api/sync/cron/route.ts) and
[internal-sync-auth.ts:19](lib/internal-sync-auth.ts), and carried in the root
crontab's `Authorization: Bearer …` header for `POST /api/sync/cron`.

It must **not** be rotated before Step 12. The wrapper records
`rootcron_block_sha256` and `resume-scheduler` compares the managed cron block
against it, so changing the header mid-cutover breaks that proof.

Rotation, as its own bounded step after `resume-scheduler` passes:

1. Generate a new value on the host (`openssl rand -hex 32`) — never in a shared
   transcript, never echoed.
2. Update `CRON_SECRET` in `.env.production` **and** the crontab header in one
   window; they must match or the cron call 401s.
3. Recreate web and worker so the new value is read — env is read at container
   creation, so a file edit alone changes nothing.
4. Prove: `/api/sync/cron` returns non-401 with the new token and 401 with the
   old one; `/tmp/adsecute-sync-cron.log` advances on the next `*/10` tick.
5. Re-record the crontab hash as the new expected value.

Because the crontab hash changes, run this **after** the cutover's scheduler
proof is complete and recorded, not inside it.

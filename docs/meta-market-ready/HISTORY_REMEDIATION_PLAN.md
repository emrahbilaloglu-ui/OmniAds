# Clean-history remediation for `app/dev-preview-share`

**Status: NOT EXECUTED. Nothing in this document has been run.** Every command
below requires explicit approval, and Phase B requires a second, separate
approval after Phase A has been verified.

Repository: `/Users/harmelek/Adsecute` (`emrahbilaloglu-ui/OmniAds`)
Branch: `meta-market-ready`
Measured: 2026-08-26

**This document pins no HEAD and no commit count.** Both move every time
anything is committed — including the evidence and status commits this work
produces — so a number written here is stale before it is read. Earlier
revisions said 7, then 9, then 24, and each was wrong within hours: at
`f06d923f3` the range really was 24, at `db50bea17` it was 28, and the status
document still said 24 there. Every count below is a COMMAND to run at
execution time, and the one number the procedure needs pinned — the
pre-rewrite HEAD — is captured by step A1 into a file, not typed into prose.

---

## 1. What happened, in full

`app/dev-preview-share/page.tsx` is user-owned and deliberately untracked. It
was swept into the index **twice**, both times by a broad `git add -A` rather
than a named path:

| # | Added by | Removed by |
|---|---|---|
| 1 | `eee701160` — WP8: render the 409, build the transition menu | `b719400a3` — Untrack app/dev-preview-share |
| 2 | `ab80dc1f9` — WP13: port the Meta Stop ceremony | `f7d7057cc` — Untrack app/dev-preview-share again |

The file's bytes never changed. The blob is
`7eee531c6d5e783f389e05e99ea6cd73cbedc1b4` in both additions
(`git rev-parse eee701160:app/dev-preview-share/page.tsx` and
`git rev-parse ab80dc1f9:app/dev-preview-share/page.tsx` return the same hash),
and the working copy still digests to `319c80d401494da99f507a4e4bb87c61`. The
exposure is that the bytes are readable from local git history, not that
anything was edited or lost.

**Seven commits on this branch carry the path in their tree.** Measured, not
counted by hand:

```bash
for c in $(git rev-list eee701160~1..HEAD); do
  git rev-parse -q --verify "${c}:app/dev-preview-share/page.tsx" >/dev/null \
    && git log -1 --format='%h %s' "$c"
done
```

```
eee701160  WP8: render the 409, build the transition menu, and close two server gaps
ffc46fc60  WP8: give the decision a route into the manual action sheet
97c9e181a  WP8: put the Decision Center's own words through the copy catalogue
428f6c950  Overview: build the four capabilities the design names
8f15c972a  WP16: run the Decisions repoint, and record what it measured
06cbc884d  Record what this pass built, and recapture the evidence it changed
ab80dc1f9  WP13: port the Meta Stop ceremony onto the body the route mounts
```

The rewrite RANGE is larger than that, and grows with every commit:
`eee701160~1..HEAD` covers every commit after the first addition, because each
one's parent changes whether or not its own tree carries the file. Run
`git rev-list --count eee701160~1..HEAD` at execution time — it was 24 at
`f06d923f3`, 28 at `db50bea17`, and 32 while this paragraph was being written.
That is precisely why no expected value is recorded here.

> Earlier revisions said "seven commits", then "nine", then "24", and claimed
> `eee701160` was "the only commit that touches the path". They conflated
> *commits whose tree carries the file* — a fixed set of seven, because the two
> additions and the range between them are history — with *commits a rewrite
> would rewrite*, which grows with every new commit. The first number is stable
> and is listed above. The second is a measurement, never a constant.

## 2. Where the blob is reachable from — including outside this branch

This is the fact that reshapes the whole plan, and it was in no earlier
revision.

**The branch.** `refs/heads/meta-market-ready` is the only ref that descends
from `eee701160`:

```bash
git for-each-ref --format='%(refname)' | while read -r r; do
  git merge-base --is-ancestor eee701160 "$r" 2>/dev/null && echo "$r"
done
# refs/heads/meta-market-ready
```

**Two refs outside it carry the same blob independently.** The Codex tooling in
this working tree writes its own turn-diff refs, and two of them hold a tree
containing the path:

```bash
for r in $(git for-each-ref --format='%(refname)' refs/codex refs/stash); do
  git rev-parse -q --verify "${r}:app/dev-preview-share/page.tsx" >/dev/null && echo "$r"
done
# refs/codex/turn-diffs/captures/1787684943906/…/base                   -> 792c3e307
# refs/codex/turn-diffs/checkpoints/9f788053…/bff28d85…/1787635490589/… -> ac9872d44
```

Both resolve to blob `7eee531c6d5e783f389e05e99ea6cd73cbedc1b4` — the same
bytes. `refs/stash` holds one entry
(`stash@{0}: On main: pre-clean-meta-public-share-2026-08-22`) and does **not**
carry the path.

**Consequence, stated plainly:** rewriting `meta-market-ready` cannot on its own
make this blob unreachable. Any plan whose success criterion is "the blob is
gone" must also decide what happens to those two refs — and they are not this
branch's to delete. They are another tool's checkpoint state, and removing them
is a decision about that tool's recoverability. Phase B names this as a
precondition rather than assuming it away.

**The remotes.** Both configured remotes were queried LIVE, not inferred from
remote-tracking refs:

```
$ git remote -v
origin      https://github.com/emrahbilaloglu-ui/OmniAds.git (fetch)
origin      git@github.com:emrahbilaloglu-ui/OmniAds.git (push)
origin-ssh  git@github.com:emrahbilaloglu-ui/OmniAds.git (fetch)
origin-ssh  git@github.com:emrahbilaloglu-ui/OmniAds.git (push)

$ git ls-remote --heads origin meta-market-ready       -> (no output)
$ git ls-remote --heads origin-ssh meta-market-ready   -> (no output)
```

Neither remote holds this branch, and there is no remote-tracking ref for it.
`origin` and `origin-ssh` point at the same GitHub repository over different
transports, so they are two names for one destination — but both are asked,
because a configured remote that is never queried is an assumption. A
remote-tracking ref is a cache and proves nothing about the remote.

## 3. Why this has not been done unasked

Rewriting `eee701160~1..HEAD` changes **every commit hash in that range** —
run the count above — including the HEAD
that every measurement in `RUNTIME_EVIDENCE_AND_STATUS.md` is stamped with, the
commit table in that document, and the evidence directories under
`playwright/artifacts/` that are NAMED after commit hashes
(`zero-base/e39edab850/`, `meta-runtime/meta-market-ready-0e5ea61b13/`). A
rewrite that does not also re-stamp those leaves a record pointing at commits
that no longer exist — a worse state than the one it repairs.

That is a decision about the project's history, not a defect to fix quietly.

## 4. Two phases, because they have different blast radii

The previous revision was internally incompatible: it created a backup ref in
step 1 and then, in step 5, expected `git log --oneline --all -- <path>` to be
empty and the blob to be unreachable. The backup ref exists precisely to keep
those objects alive, so those checks could never pass while it did. The work is
split accordingly.

**Phase A is reversible.** It rewrites the branch while a backup ref still holds
the old commits. Its verification is about the REWRITTEN BRANCH only: this
branch's path history, this branch's trees, this branch's working copy. It
deliberately does **not** check `--all`, and deliberately does **not** check
that the blob is unreachable — both would be false by design, because the
backup is doing its job.

**Phase B is irreversible and separately approved.** It removes the internal
safety net and expires the objects. Only then is "the blob is unreachable" a
meaningful check — and only if the Codex refs in §2 have been dealt with first.

---

## Phase A — rewrite, with a way back

Approval required. Nothing below has been run.

**A1 — Anchor the current history, and pin the numbers this run will use.**

```bash
git rev-parse HEAD > ~/meta-market-ready-pre-rewrite-head.txt
git branch meta-market-ready-pre-history-rewrite HEAD
git rev-parse meta-market-ready-pre-history-rewrite
git rev-list --count eee701160~1..HEAD > ~/meta-market-ready-pre-rewrite-count.txt
md5 -q app/dev-preview-share/page.tsx > ~/meta-market-ready-userfile-md5.txt
```

Nothing after this can lose work while that ref exists. The three files are the
pinned facts for THIS run — A6 compares against them rather than against a
number typed into a document.

**A2 — Re-query BOTH remotes, live.**

```bash
git remote -v
git ls-remote --heads origin meta-market-ready
git ls-remote --heads origin-ssh meta-market-ready
git for-each-ref --format='%(refname) %(objectname)' refs/remotes | grep meta-market-ready || echo "no remote-tracking ref"
```

If any of the first three produces output naming this branch, **stop**.
Rewriting shared history is a different operation with a different blast radius,
and the file has already left the machine. Re-run this at execution time
whatever §2 recorded: a branch can be pushed between writing a plan and
approving it. Both remotes are asked even though they are two transports to one
GitHub repository — a configured remote that is never queried is an assumption.

**A3 — Confirm what is about to be rewritten.**

```bash
git rev-list --count eee701160~1..HEAD                       # matches the A1 file
for c in $(git rev-list eee701160~1..HEAD); do
  git rev-parse -q --verify "${c}:app/dev-preview-share/page.tsx" >/dev/null \
    && git log -1 --format='%h %s' "$c"
done                                                          # expect the 7 in §1
md5 -q app/dev-preview-share/page.tsx                         # matches the A1 file
```

Note the `${c}:path` braces. Without them zsh applies its `:a` modifier to `$c`
and the loop silently reports "absent" for every commit — this document's own
first attempt at that check did exactly that, and reported a clean history for a
history that was not clean.

**A4 — Rewrite in a SCRATCH CLONE. Never in this working copy.**

This is the step the previous revision got dangerously wrong. It proposed
`git rebase -i eee701160~1` in place, and claimed the working copy was "left
alone". That claim is false, and predictably so:

- `app/dev-preview-share/page.tsx` exists in THIS working tree as an untracked
  file;
- `eee701160` and `ab80dc1f9` both ADD that exact path;
- checking either out over an untracked file is refused —
  *"error: The following untracked working tree files would be overwritten by
  checkout"* — so the rebase stops mid-flight, on a detached HEAD, with the
  branch half-rewritten;
- and if it did not refuse, it would OVERWRITE the user's file, which is the one
  outcome this whole document exists to avoid.

So the rewrite happens somewhere that has never heard of the file. A clone
carries committed objects only — untracked files never travel — which was
verified rather than assumed:

```
$ git clone --no-checkout --quiet /Users/harmelek/Adsecute /tmp/clone-probe
$ git -C /tmp/clone-probe ls-tree HEAD app/dev-preview-share/
(no output — absent, because it is untracked here)
$ git -C /tmp/clone-probe rev-parse -q --verify "eee701160:app/dev-preview-share/page.tsx"
7eee531c6d5e783f389e05e99ea6cd73cbedc1b4      (the blob IS there, so a rewrite is meaningful)
$ ls /tmp/clone-probe
(empty — --no-checkout materialises no worktree at all)
```

The probe was run and removed; the user file's md5 and mtime were unchanged
afterwards. Note the size: `.git` was **1.1 GiB**, so the scratch needs disk.

```bash
# 1. A scratch clone. --no-hardlinks so nothing the rewrite does can touch the
#    source object store; --no-checkout so no worktree is ever materialised and
#    the user path cannot be written anywhere.
git clone --no-hardlinks --no-checkout /Users/harmelek/Adsecute /tmp/rewrite-scratch
cd /tmp/rewrite-scratch
git checkout -B meta-market-ready origin/meta-market-ready   # a worktree WITHOUT the untracked file

# 2. Rewrite there. See A4b for the two candidate tools and their status.

# 3. Verify there (A6 runs inside the scratch).

# 4. Bring the result back as an OBJECT, not as a checkout:
cd /Users/harmelek/Adsecute
git fetch /tmp/rewrite-scratch meta-market-ready:refs/heads/meta-market-ready-rewritten
git diff --stat meta-market-ready meta-market-ready-rewritten   # expect: no output
git update-ref refs/heads/meta-market-ready refs/heads/meta-market-ready-rewritten
```

The last step is safe for the working copy precisely because the check above it
passed: HEAD's TREE is identical before and after, so moving the branch ref
changes which commits exist and changes no file. Git never touches the working
directory, and the untracked user file is never a candidate for anything. If
`git diff --stat` prints ANYTHING, stop — the trees differ and this is no longer
a history-only rewrite.

**A4b — The rewrite command itself is NOT VERIFIED here.**

Stated plainly rather than presented as executable:

- `git filter-repo` is **not installed on this machine**
  (`command -v git-filter-repo` → no output), so its `--refs eee701160~1..HEAD`
  range semantics could not be exercised. `filter-repo` also normally refuses to
  run against a non-fresh clone and rewrites ALL refs unless `--refs` is given,
  and whether `--refs` accepts a range rather than a ref name in the installed
  version is exactly what could not be checked. **Do not paste it and hope.**
  Install it in the scratch, run `git filter-repo --analyze` first, and confirm
  on a throwaway copy that only the intended refs moved.
- The interactive-rebase form works in a scratch clone because the untracked
  file is not there — but it too was NOT executed, because this pass was
  forbidden from running any history mutation.

Either way, the procedure is: run it in `/tmp/rewrite-scratch`, verify with A6
INSIDE the scratch, and only then fetch the result back. A rewrite that cannot
be verified in the scratch must not be fetched.

**A5 — Drop the two commits that now do nothing.**

`b719400a3` and `f7d7057cc` exist only to undo the two additions. After A4 both
are empty. `filter-repo` prunes empty commits automatically; the rebase form
needs an explicit `drop` for each.

**A6 — Verify, and verify only what Phase A can be true about.**

Checks 1, 2 and 4 run INSIDE `/tmp/rewrite-scratch`, against the rewritten
branch, BEFORE anything is fetched back. Check 3 runs in the real repository,
before and after the `update-ref`, and both readings must match the A1 file.

```bash
# 1. The path is absent from the REWRITTEN branch's history.
git log --oneline meta-market-ready -- app/dev-preview-share      # expect: no output

# 2. No commit on this branch carries it in its tree.
for c in $(git rev-list meta-market-ready); do
  git rev-parse -q --verify "${c}:app/dev-preview-share/page.tsx" >/dev/null \
    && echo "STILL PRESENT: $c"
done                                                              # expect: no output

# 3. The user's file, in the REAL repository, before AND after the update-ref.
#    Byte-identical, still untracked, and never staged.
md5 -q app/dev-preview-share/page.tsx                             # must equal ~/meta-market-ready-userfile-md5.txt
stat -f "%Sm" app/dev-preview-share/page.tsx                      # mtime must not have moved
git ls-files --error-unmatch app/dev-preview-share/page.tsx && echo "TRACKED — STOP"
git status --porcelain --untracked-files=all                      # expect only: ?? app/dev-preview-share/page.tsx

# 4. THE CODE IS UNCHANGED. This is the check that matters, and it is what
#    makes the object-level update-ref safe: identical trees mean git has no
#    file to write, so the untracked user path is never a candidate.
git diff --stat meta-market-ready-pre-history-rewrite meta-market-ready   # expect: no output
```

Check 4 is the point of the whole phase: the rewrite must change **which commits
exist** and nothing about **what the code is**.

**Deliberately NOT checked in Phase A**, and the earlier revision was wrong to:

- `git log --all -- <path>` — the backup ref from A1 still reaches the old
  commits, and the two Codex refs in §2 carry the blob independently. Expecting
  this to be empty is expecting the safety net not to exist.
- `git cat-file -e <blob>` — the blob is alive by design while the backup
  exists. Its survival here is success, not failure.

**A7 — Re-stamp the record, in one commit.**

`docs/meta-market-ready/RUNTIME_EVIDENCE_AND_STATUS.md` names commit hashes in
its header, its §1 commit table and its §5 evidence rows, and this document
names them throughout. Rewrite both from `git log --oneline` after the rewrite,
and say in the commit message that the hashes changed and why.

The evidence directories are a separate decision.
`playwright/artifacts/zero-base/e39edab850/` and
`playwright/artifacts/meta-runtime/meta-market-ready-0e5ea61b13/` are named after
commits that will no longer exist. Either recapture them (about 35 minutes of
harness time, and it changes their contents), or leave them with a stated note
that their labels are pre-rewrite hashes. Renaming the directories by hand would
make their manifests lie — each manifest records the commit it was captured at.

**Phase A stops here.** The branch is clean, the old history is one ref away,
and nothing is unrecoverable.

---

## Phase B — irreversible cleanup

**A SEPARATE approval, given after Phase A has been verified.** Not in the same
sitting as Phase A. Its whole purpose is to destroy the way back.

**B0 — Decide what happens to the refs Phase A cannot touch.**

Phase A leaves the blob reachable from the two `refs/codex/turn-diffs/*` refs in
§2. This must be resolved before B4's verification can pass, and it is not this
branch's decision to make:

```bash
for r in $(git for-each-ref --format='%(refname)' refs/codex refs/stash); do
  git rev-parse -q --verify "${r}:app/dev-preview-share/page.tsx" >/dev/null && echo "$r"
done
```

For each ref listed, whoever owns that tooling must decide whether it may be
deleted. If any is kept, **Phase B cannot deliver an unreachable blob**, and the
honest outcome is to stop after Phase A and say so, rather than run a `gc` that
will not achieve what it claims.

**B1 — External backup, outside `.git`.**

Deleting the internal backup ref removes the only way back. If recoverability is
still wanted after that, it has to live somewhere `git gc` cannot reach:

```bash
# Create. Outside the repository, and outside any directory git tracks.
git bundle create ~/adsecute-pre-history-rewrite.bundle meta-market-ready-pre-history-rewrite

# Verify it is a valid, complete bundle BEFORE deleting anything.
git bundle verify ~/adsecute-pre-history-rewrite.bundle
git bundle list-heads ~/adsecute-pre-history-rewrite.bundle    # expect the backup ref

# Prove it restores, into a THROWAWAY clone — never into this repository.
git clone ~/adsecute-pre-history-rewrite.bundle /tmp/restore-probe
git -C /tmp/restore-probe rev-parse HEAD                        # expect the A1 hash
rm -rf /tmp/restore-probe
```

**The bundle contains the user's file.** It is the same exposure moved
somewhere else, so it is a deliberate choice rather than a default: keep it only
if someone has decided the old history is worth retaining, store it outside the
repository, and delete it when it is not.

**Protection against pushing it back.** A bundle cannot be pushed by accident,
but the ref it restores can:

- Never `git remote add` the bundle to this repository.
- If it is ever restored, restore into a throwaway clone as above, never into
  `/Users/harmelek/Adsecute`.
- A `git push` of a rewritten branch would be rejected as a non-fast-forward
  anyway. Nothing here is ever pushed with `--force`.

**B2 — Delete the internal safety net.**

```bash
git branch -D meta-market-ready-pre-history-rewrite
git for-each-ref --format='%(refname)' | grep pre-history-rewrite || echo "backup ref gone"
```

**B3 — Expire ONLY the reflogs this remediation affects, then collect.**

`--all` is wrong here and the previous revision was wrong to use it. This
repository has four branch reflogs plus HEAD's:

```
$ ls .git/logs/refs/heads
codex  main  meta-market-ready  meta-surfaces-functional-2026-08-19
```

`git reflog expire --expire=now --expire-unreachable=now --all` destroys the
recovery history of `main`, `codex` and `meta-surfaces-functional-2026-08-19`
as well — branches this remediation has nothing to do with, whose reflogs are
someone's way back from an unrelated mistake. Scope it:

```bash
# Named refs only. The backup ref must already be deleted (B2), or its reflog
# holds the old commits and this achieves nothing.
git reflog expire --expire=now --expire-unreachable=now \
  refs/heads/meta-market-ready HEAD

# Verify the untouched ones are still there BEFORE collecting.
git reflog show main | head -3                                  # expect entries
git reflog show refs/heads/codex | head -3                      # expect entries

git gc --prune=now
```

The ref-scoped form was checked on this machine rather than assumed:
`git reflog expire --dry-run --expire=90.days refs/heads/meta-market-ready`
exits 0 and leaves the reflog at its original length (git 2.50.1). Only the
`--dry-run` was executed; nothing was expired.

`--expire-unreachable=now` is what actually releases the old objects;
`--expire=now` alone leaves unreachable entries behind. `--aggressive` is
omitted: it repacks everything, takes far longer, and changes nothing about what
is pruned.

If the two Codex refs from §2 are still present (B0), the old objects remain
reachable through them and `gc` will not release the blob. That is not a reason
to widen the expiry — it is the B0 decision, and the honest outcome is to stop.

**B4 — Verify, and only now. And do not promise more than B0 allowed.**

If B0 kept either Codex ref, SKIP this section and record the outcome as
"Phase A complete; the blob remains reachable from refs outside this branch".
Running the checks below in that state produces a failure that is not a defect,
and reporting "blob gone" in that state would be false.

```bash
# The blob must be unreachable — failing to find it is the success.
git cat-file -e 7eee531c6d5e783f389e05e99ea6cd73cbedc1b4 2>/dev/null \
  && echo "STILL PRESENT — see B0" || echo "blob gone"

# No ref anywhere reaches the path.
git log --oneline --all -- app/dev-preview-share                 # expect: no output

# And the working copy is STILL the user's, untouched and untracked.
md5 -q app/dev-preview-share/page.tsx                            # expect 319c80d401494da99f507a4e4bb87c61
git status --porcelain --untracked-files=all                     # expect only: ?? app/dev-preview-share/page.tsx
```

If B4's first check still finds the blob, the cause is B0: a ref outside this
branch is still holding it. Say so; do not run `gc` again expecting a different
answer.

---

## 5. Preconditions for approval

- **Phase A:** the A2 remote check still returns nothing on BOTH remotes at
  execution time. The operator accepts that every commit hash in the range
  changes — run `git rev-list --count eee701160~1..HEAD` for the current figure
  — including the HEAD every measurement in `RUNTIME_EVIDENCE_AND_STATUS.md` is
  stamped with, and accepts A7's decision about the hash-named evidence
  directories. There is disk for a ~1.1 GiB scratch clone.
- **Phase B:** Phase A verified and its re-stamp committed. A decision has been
  made about each `refs/codex/turn-diffs/*` ref in §2 by whoever owns that
  tooling. A decision has been made about whether an external bundle is wanted
  and, if so, where it lives and when it is deleted.

## 6. If approval is withheld

Nothing further is required, and this is a defensible resting state. The file is
untracked, its bytes are unchanged, the branch has never been pushed to either
remote, and four commit messages record what happened and why. The exposure is
local, and the history is honest about it.

## 7. What must never be run without the approvals above

`git filter-repo`, `git rebase` over this range, `git reset`, `git update-ref`,
`git reflog expire` (other than `--dry-run`), `git gc --prune`, `git branch -D`
of the backup ref, restoring a bundle into this repository, or any push — forced
or otherwise.

None of it has been run. What WAS run, and only these:

- `git ls-remote --heads` against both remotes (read-only);
- `git clone --no-checkout` to a scratch path, to verify that an untracked file
  does not travel into a clone, followed by `rm -rf` of that path;
- `git reflog expire --dry-run` against one named ref, to verify the ref-scoped
  syntax is accepted on git 2.50.1.

After all three, `app/dev-preview-share/page.tsx` was still untracked, still
`319c80d401494da99f507a4e4bb87c61`, and its mtime had not moved.

`git-filter-repo` is not installed on this machine, so no command using it has
been verified — see A4b.

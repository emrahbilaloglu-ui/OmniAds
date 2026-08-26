# Clean-history remediation for `app/dev-preview-share`

**Status: NOT EXECUTED. Requires explicit approval before any command below is run.**

Branch: `meta-market-ready`
HEAD at the time of writing: `b719400a3`
Upstream: **none** — `git rev-parse --abbrev-ref @{u}` answers
`fatal: no upstream configured for branch 'meta-market-ready'`. The branch has
never been pushed, so this history exists on one machine and nowhere else.

---

## 1. What happened

`app/dev-preview-share/page.tsx` is user-owned and was deliberately untracked.
`eee701160` staged with `git add -A` instead of naming its paths and swept the
file into the commit. `b719400a3` removed it from the index and restored it to
untracked.

Two commits therefore exist that a clean history would not contain, and the
file's 187 lines are readable in the local object store at any time by

```bash
git show eee701160:app/dev-preview-share/page.tsx
```

## 2. What is and is not at risk

**The file's content was never altered.** `eee701160` is the only commit that
touches the path (`git log --oneline -- app/dev-preview-share/page.tsx` returns
one line), no later commit modified it, and the working copy's digest is
unchanged at `319c80d401494da99f507a4e4bb87c61`. The exposure is that the bytes
are in local git history, not that they were edited.

**The exposure is local only, and that was checked rather than assumed.** Two
remotes are configured (`origin` and `origin-ssh`, both
`emrahbilaloglu-ui/OmniAds`), and neither holds this branch:

```
$ git ls-remote --heads origin meta-market-ready
(no output)
$ git for-each-ref refs/remotes | grep meta-market-ready
(no output)
```

There is no upstream, no remote-tracking ref, and no `git push` has run in this
session. Step 2 of §4 re-runs that check at execution time rather than trusting
this paragraph, because a branch can be pushed between writing a plan and
approving it.

The blob is `7eee531c6d5e783f389e05e99ea6cd73cbedc1b4`. It is reachable from
`eee701160` and from every commit between it and `b719400a3` except through the
tree removal, and it is additionally reachable from the reflog and from any
stash or `ORIG_HEAD` written since.

## 3. Why it has not been done unasked

Removing the blob means rewriting **seven commits** — every commit from
`eee701160` to `HEAD`:

| Commit | Subject |
|---|---|
| `eee701160` | WP8: render the 409, build the transition menu, and close two server gaps |
| `ffc46fc60` | WP8: give the decision a route into the manual action sheet |
| `97c9e181a` | WP8: put the Decision Center's own words through the copy catalogue |
| `428f6c950` | Overview: build the four capabilities the design names |
| `8f15c972a` | WP16: run the Decisions repoint, and record what it measured |
| `06cbc884d` | Record what this pass built, and recapture the evidence it changed |
| `b719400a3` | Untrack app/dev-preview-share, which a broad `git add -A` swept in |

Every one of those hashes changes. Five of them are cited by name in
`docs/meta-market-ready/RUNTIME_EVIDENCE_AND_STATUS.md`, one is the HEAD that
document's measurements are stamped with, and three commit messages quote
sibling hashes. A rewrite silently makes all of those references point at
commits that no longer exist — which is a worse record than the one being
repaired, unless the same change updates them.

That is a decision about the project's history, not a defect to fix quietly, so
it waits for an explicit instruction.

## 4. The plan, exactly

Run in this order. Every step is verifiable and the whole thing is reversible
from the backup ref in step 1 until step 7 deletes it.

**1 — Anchor the current history.**

```bash
git branch meta-market-ready-pre-history-rewrite b719400a3
git rev-parse meta-market-ready-pre-history-rewrite
```

Nothing below can lose work while that ref exists.

**2 — Confirm the exposure is still local.**

```bash
git remote -v
git for-each-ref --format='%(refname) %(objectname)' refs/remotes | grep meta-market-ready || echo "no remote tracking ref"
```

If either shows a remote holding this branch, **stop**: rewriting shared history
is a different operation with a different blast radius, and the file has already
left the machine. Report and re-plan.

**3 — Rewrite the range, dropping the path.**

```bash
git filter-repo --force --refs eee701160~1..HEAD \
  --path app/dev-preview-share --invert-paths
```

`git-filter-repo` is the tool git's own documentation points to for this;
`filter-branch` is deprecated and its `--index-filter` form leaves the original
refs behind under `refs/original/`. If `filter-repo` is not installed, the
equivalent without it is an interactive rebase — `git rebase -i eee701160~1`,
`edit` on `eee701160`, then `git rm --cached app/dev-preview-share/page.tsx &&
git commit --amend --no-edit && git rebase --continue`, and finally `git rebase
-i` again to drop `b719400a3`, which has no purpose once the file was never
added. The rebase form is slower and equally correct.

**4 — Drop the now-meaningless commit.**

`b719400a3` exists only to undo `eee701160`'s mistake. After step 3 it is an
empty commit; `filter-repo` prunes it automatically, and the rebase form needs
an explicit `drop`.

**5 — Verify, before trusting anything.**

```bash
# The path must be absent from every commit in the range.
git log --oneline --all -- app/dev-preview-share            # expect: no output
# The blob must be unreachable.
git cat-file -e 7eee531c6d5e783f389e05e99ea6cd73cbedc1b4 && echo "still present"
# The working copy must be byte-identical and untracked.
md5 -q app/dev-preview-share/page.tsx                        # expect 319c80d401494da99f507a4e4bb87c61
git status --porcelain --untracked-files=all                 # expect only: ?? app/dev-preview-share/page.tsx
# The tree must be identical to the pre-rewrite HEAD.
git diff --stat meta-market-ready-pre-history-rewrite HEAD   # expect: no output
```

The last check is the one that matters: the rewrite must change **which
commits** exist and nothing about **what the code is**.

**6 — Re-stamp the record.**

The five hashes in `docs/meta-market-ready/RUNTIME_EVIDENCE_AND_STATUS.md`, the
`Code HEAD:` line, and the three commit messages that quote siblings all name
commits that no longer exist. Rewrite the document's commit table and HEAD line
from `git log --oneline` after the rewrite, in one commit, and say in that
commit that the hashes changed and why. A record that silently points at dead
commits is worse than the mistake it was written to fix.

**7 — Expire the old objects.**

```bash
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git cat-file -e 7eee531c6d5e783f389e05e99ea6cd73cbedc1b4 || echo "blob gone"
```

Only after step 5 has passed and the backup ref has been deleted
(`git branch -D meta-market-ready-pre-history-rewrite`) — the backup keeps the
blob alive by design, which is the point of it right up until it is not needed.

## 5. Preconditions for approval

- The check in §2 still holds at execution time. It held when this was written:
  `git ls-remote --heads origin meta-market-ready` returned nothing.
- The operator accepts that seven commit hashes change, including the HEAD every
  measurement in `RUNTIME_EVIDENCE_AND_STATUS.md` is stamped with.
- The operator accepts that the evidence artefacts committed under
  `playwright/artifacts/` are named after the OLD hashes
  (`meta-market-ready-8f15c972a0`, `zero-base/8f15c972a0/`) and will either be
  renamed and recaptured, or left with a stated note that their labels refer to
  pre-rewrite hashes. Recapturing costs about 35 minutes of harness time;
  relabelling by hand would make the manifests lie.

## 6. If approval is withheld

Nothing further is required. The file is untracked, its bytes are unchanged, the
branch is unpushed, and `b719400a3` records what happened and why in its own
message. The exposure stays local and the history stays honest about it.

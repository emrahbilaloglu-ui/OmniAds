# Self-Hosted Runtime Smoke

CHATGPT_REVIEW_READY: YES
SANITIZED: YES

# Status

Not executed by Codex.

Exact blocker: Codex did not have an authenticated self-hosted browser state in
this shell. Codex did not ask for a domain, DB URL, token, cookie, browser
session value, server credential, or secret.

This remains a main/product-ready blocker. For PR #82 to PR #78 WIP branch
consideration, the static no-write enforcement tests, CI safety gate, and prior
supervised preview evidence are substitute evidence only if ChatGPT/owner
accepts that scope.

# Manual Runner

Added command:

```bash
npm run creative:v2:self-hosted-smoke
```

Implementation:

- `scripts/creative-v2-self-hosted-smoke.ts`

# Safe Local Execution

An authorized owner can run the smoke in an existing authenticated self-hosted
environment by setting local environment values that are not committed:

```bash
CREATIVE_V2_SMOKE_BASE_URL="<existing self-hosted OmniAds URL>" \
CREATIVE_V2_SMOKE_STORAGE_STATE="<optional local Playwright storage-state path>" \
npm run creative:v2:self-hosted-smoke
```

Do not paste or commit domains, cookies, tokens, DB URLs, server credentials, or
raw customer/account/creative names into reports.

# Validations Performed By Runner

The runner validates:

- `/platforms/meta/creatives` without the flag does not render the v2 preview surface.
- `/platforms/meta/creatives?creativeDecisionOsV2Preview=1` renders the v2 preview surface.
- Today Priority is visible.
- Scale-ready copy is visible.
- Ready for Buyer Confirmation is visible.
- Diagnose is visible.
- Inactive Review is visible.
- forbidden action language is absent.
- internal artifact language is absent.
- no captured POST/PUT/PATCH/DELETE request appears during the no-flag page,
  flagged preview page, or first v2 read-only row detail-open interaction.

# Sanitization

The runner prints sanitized JSON only. It records path-only request evidence and
does not print the base domain, raw IDs, raw names, cookies, tokens, DB URLs, or
server details.

# Remaining Gate

A fresh authenticated self-hosted runtime smoke remains open until an authorized
owner runs the command or an equivalent supervised smoke in the existing
self-hosted environment.

# Formatting Correction

The smoke runner was reformatted in commit
`5cf72894e175cd050948e4bf881fc738b1358caa`.

Public raw verification:

| File | Line count | Lines over 220 chars |
| --- | ---: | --- |
| `scripts/creative-v2-self-hosted-smoke.ts` | 133 | none |

The file is readable multi-line TypeScript.

# ITEM 18 — Does the canonical reference define an Assets detail drawer?

**Answer: NO. It defines the opposite, explicitly, and a parity defect was
already filed and closed to remove the drawer that used to be there.**

Status of the code change: **INTENTIONAL REMOVAL — not "CLOSED functional".**
Nothing was built. A dead type field and a dead callback were removed from a
data model to stop them reading as a shipped capability. There is no new Assets
detail read, no new drawer, and no new server verification, because the
reference asks for none.

---

## The proof, from the canonical reference

`docs/dashboard-v2-parity-defects.md` quotes the design HTML and the per-screen
data model. Two places in it answer this question directly.

**1. The design quote — `docs/dashboard-v2-parity-defects.md:1286`**

> **Design:** The Assets row's sole handler is `r.toggle` at line 758; the
> dedicated checkbox and full row both represent the pin state. The only Studio
> drawer trigger is the Copies row handler at line 813.

Two facts in one sentence:

- The Assets row's **sole** handler in the design is `r.toggle` — the pin.
- The **only** Studio drawer trigger in the design is the **Copies** row
  handler. Not "one of the triggers": the only one.

**2. The closed verdict — `docs/dashboard-v2-parity-defects.md:1023`**

> | CREATIVE-42 | CLOSED | An Assets row performs only the canonical pin toggle;
> the old asset usage/evidence drawer path is not mounted from this screen. |

**3. The defect this was — `docs/dashboard-v2-parity-defects.md:1284–1288`**

> ### CREATIVE-42 · MEDIUM · **EXTRA** — Clicking an Assets row opened an asset
> usage/evidence surface instead of only pinning it
>
> **Code before:** The old Assets controller loaded usage data and mounted Studio
> asset evidence/detail behavior in addition to selection, introducing a
> screen/state the canonical Assets tab does not define.
>
> **Fix:** `CreativeStudioExact` binds each Assets row only to `togglePin`; the
> page supplies pin-state persistence but no Assets `onOpenRow` or usage drawer.
> The exact interaction test asserts row click creates a comparison card and
> nothing else.

The defect class is **EXTRA** — the repo had a screen the design does not draw.
The correction was to delete it, and that correction is already closed.

**4. Corroboration in the drawers pass — `docs/dashboard-v2-parity-defects.md:4574`**

> the Studio copies row opens `copyOpen`, the copy detail drawer

and `DRAWERS-06`, at :4626:

> One evidence window remains, on the design's own trigger. The Studio-table
> drawer, its loader, its state and its trigger button are removed from
> `StudioOsView` …

Two drawers exist in the reference for this family: the **creative evidence
window** (opened from the Meta decision surface's own trigger) and the **Copy
detail drawer** (opened from the Copies row). Neither is an Assets drawer.

---

## What follows, and what does not

Because the reference defines no Assets detail drawer, the conditional branch of
ITEM 18 that would apply — "build a new exact READ-ONLY drawer, re-check
business + assigned account + creative/ad identity on the SERVER, keep pin and
the drawer as separate click targets" — **does not apply**. Building it would:

- add a screen the canonical design does not define, and
- re-open CREATIVE-42, a defect already closed in the other direction.

So the correct action is the one taken: state the absence as a decision, cite the
reference where the decision comes from, and make the absence testable.

### What is in the tree now

- `components/creatives/creative-studio-exact-types.ts` —
  `CreativeStudioAssetsModel` carries `state`, `message`, `syncedCount`, `rows`,
  `persistenceKey` and `onPinnedIdsChange`. It carries **no** `onOpenRow`, and
  the doc comment above it now quotes the reference and the file:line it comes
  from, so the next reader does not have to re-derive the decision.
- `components/creatives/CreativeStudioExact.tsx` — each Assets row is bound to
  `togglePin` (`:507`, `:657`, `:658`). The `onOpenRow` binding at `:815` belongs
  to the **Copies** table, which is the design's only Studio drawer trigger.
- `components/creatives/CreativeStudioExact.test.tsx` — "keeps an Assets row
  bound to the pin alone, honouring no detail opener". The test deliberately
  passes a stray `onOpenRow` onto the Assets model anyway and asserts the surface
  **ignores** it while the pin still lands. Re-adding the field therefore cannot
  quietly re-add the screen; a caller would have to change the component too, and
  that change fails this test.

### Provider writes

Zero. Nothing in this item reads or writes a provider. The only behaviour under
test is a local pin toggle.

---

## If this is ever revisited

Reviving an Assets detail drawer is a **design change**, not a defect fix. It
needs, in order:

1. A canonical reference that defines it (a trigger, a geometry and a data
   model), the way `:1286` currently defines its absence.
2. A server-verified read: business + assigned provider account + creative/ad
   identity re-checked on the server, not inferred from a URL or a row payload —
   `INVARIANTS.md`'s "Warehouse entity rows, recommendation payloads, and
   synthetic IDs are discovery evidence only".
3. Separate click targets for the pin and the drawer, because the row already
   means "pin" to every operator who has used this screen.

Until (1) exists, the honest state is the one in the tree: no drawer, and a
comment saying which line of the reference decided that.

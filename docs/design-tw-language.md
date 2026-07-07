# Triple-Whale-inspired visual language (design-tw-uplift branch)

Reference distilled from walking the live Triple Whale app (Summary, Marketing
Acquisition, Creative Analysis, Moby, Discovery) on 2026-07-07. The user finds
it calm/non-straining and useful. Goal: real, data-backed surfaces re-skinned to
this language — NOT a pastel/artificial wireframe look.

## Principles
- Calm and neutral. Truly neutral grays (not slate/indigo-tinted). Low contrast
  chrome, high contrast only on the numbers that matter.
- Numbers are the hero. Large bold metric numerals (~30-34px), muted small
  labels above them. Tabular numerals everywhere.
- Flat surfaces. White cards on a near-white gray canvas, thin neutral borders,
  little or NO shadow. No nested cards. No decorative gradients on surfaces.
- Restrained accent. One blue primary; emerald for positive delta, rose for
  negative. Sparklines are a thin blue→emerald gradient line, no fill.
- Generous whitespace, quiet section headers (small icon + name + info dot,
  actions right-aligned and low-emphasis).

## Tokens (applied to the .ad-final system + shell)
- Canvas `--bg`: #F7F8FA. Surface: #FFFFFF. Subtle surface: #FAFAFB.
- Borders: #ECEDEF (hairline), #E2E4E8 (stronger). Neutral, no blue tint.
- Ink: #10151C (primary), #3B424C (secondary), #6B7280 (muted), #9AA1AC (faint).
- Brand blue: #2F6BFF (primary), #2757D6 (hover), tint bg #EEF3FF, border #D3E0FF.
- Positive emerald: #0E9F6E fg, #E9F6F0 bg. Negative rose: #E11D48 fg, #FDECEF bg.
- Caution amber: #B45309 fg, #FBF3E2 bg. Info = brand blue family.
- Radii: 10-12px on cards, 8px on controls, 6px chips.
- Shadow: essentially flat — border does the work. --shadow-sm reduced to a
  1px hairline; larger shadows only on popovers/drawers.
- Metric numeral: 30-34px / 600-650 weight / tabular-nums / tight tracking.
- Type: label 12px muted uppercase-ish (not all-caps), body 13-14px, section
  title 15-16px, page title 20-24px.

## Sparkline
Thin (2px) line, gradient from brand blue to emerald, no area fill, rounded
caps, muted baseline. Delta chip: small arrow + percent, emerald/rose.

## What we are NOT doing
No pastel washes, no glassmorphism, no heavy drop shadows, no indigo/violet
one-note theme, no fake/empty screens (server-less surfaces are out of scope on
this branch).

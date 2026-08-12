# Zero-base font provenance and license proof

Both families are licensed under the **SIL Open Font License, Version 1.1**,
which permits embedding and redistribution in a web application provided the
license text travels with the font. That text is vendored beside the binaries
here.

## Binaries

Extracted from the hash-verified design archive **`Adsecute Zero-Base
Design.zip`** (SHA-256 `0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d`),
path `vendor/fonts/`. No font binary was downloaded, and no runtime Google
Fonts request exists anywhere in the application.

| File | SHA-256 | Source path in archive |
|---|---|---|
| `schibsted-grotesk-variable.woff2` | `e3b56e90510a84ac0ed465b822e112983eaf58e37436bf769681c31f77b1f3a7` | `vendor/fonts/schibsted-grotesk-400.woff2` |
| `fragment-mono-400.woff2` | `4f4dc27f4a770c0d02fde800daa836c8adc0d1e423b28da74baaf0d1cc3ab96c` | `vendor/fonts/fragment-mono-400.woff2` |

### Why one Schibsted file instead of the archive's four

The archive ships `schibsted-grotesk-400/500/600/700.woff2`, but all four are
**byte-identical** — one SHA-256 across all of them. Parsing the WOFF2 table
directory shows why: the file carries `fvar`, `gvar`, `avar`, `HVAR`, `MVAR`
and `STAT`, so it is a **variable font**, and its `fvar` declares a single
`wght` axis of **400–900** (default 400).

The archive's `vendor/fonts.css` declares it four times at four fixed weights.
That is wrong for a variable font: each `@font-face` pins the instance to one
weight, and four distinct URLs make the browser fetch the same 46,864 bytes up
to four times. We therefore ship the file once and declare `font-weight: 400
700`, which is the same bytes with the axis actually reachable. The design's
weights (400/500/600/700) all fall inside the declared range.

`fragment-mono-400.woff2` has no variable tables and is shipped as a static
400 weight, exactly as the archive supplies it.

## License text

Fetched from the official upstream Google Fonts repository over HTTPS.

| Family | License file | SHA-256 | Upstream path | Revision |
|---|---|---|---|---|
| Schibsted Grotesk | `OFL-schibsted-grotesk.txt` | `3b4f3063b6ac7c1e403e2c4a5e8ef3a58190ff83ed7b15af66511858699139ce` | `google/fonts` → `ofl/schibstedgrotesk/OFL.txt` | `cc054e5ee906ac9b9024971b64d821aa2561c582` |
| Fragment Mono | `OFL-fragment-mono.txt` | `ef14426248ca0404eae1ae65e61802b1627b5ec33aab117fb36edf401a81636e` | `google/fonts` → `ofl/fragmentmono/OFL.txt` | `8db5a9256b34ffad61e53aafeecb4a612faa0080` |

Raw URLs: `https://raw.githubusercontent.com/google/fonts/main/ofl/schibstedgrotesk/OFL.txt`
and `https://raw.githubusercontent.com/google/fonts/main/ofl/fragmentmono/OFL.txt`.

## Proof that each license covers its binary

A license file is only evidence if it names the thing it licenses. Each binary
was decompressed and its `name` table read directly; the copyright string in
the font matches the first line of the vendored license **exactly**, and the
font's own license URL points at the OFL.

| Family | `name[0]` copyright inside the binary | First line of vendored license | `name[14]` license URL |
|---|---|---|---|
| Schibsted Grotesk | `Copyright 2023 The Schibsted-Grotesk Project Authors (https://github.com/schibsted/schibsted-grotesk)` | identical | `https://scripts.sil.org/OFL` |
| Fragment Mono | `Copyright 2022 The Fragment-Mono Project Authors (https://github.com/weiweihuanghuang/fragment-mono)` | identical | `https://scripts.sil.org/OFL` |

Font versions recorded from `name[5]`: Schibsted Grotesk `Version 1.100;gftools[0.9.25]`,
Fragment Mono `Version 1.011; ttfautohint (v1.8.4.7-5d5b)`.

Both license files are byte-identical after their first line, which is the
expected shape of the OFL: a per-project copyright line above the standard
Version 1.1 body.

`scripts/zero-base/verify-fonts.ts` re-checks every hash in this file and
re-extracts both `name` tables, so a swapped binary or an edited license fails
the build rather than being discovered later.

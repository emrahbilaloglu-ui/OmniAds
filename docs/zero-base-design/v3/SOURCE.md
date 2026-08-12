# Vendored design contract — source and provenance

The application must never import the design package from `Downloads/` or `/tmp`.
These files are the exact bytes copied from the hash-verified archive at vendor time.

| Fact | Value |
|---|---|
| Source archive | `/Users/harmelek/Downloads/Adsecute Zero-Base Design.zip` |
| Archive SHA-256 | `0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d` |
| Active-manifest fingerprint (`audit.json.packageHash`) | `f27bf51b31ddffe20b5c6404f5b7c1758ba5087342cd84941bf6c2d937befe4a` |
| Rule version | `3.1.0` |
| Vendored at | 2026-08-11 |
| Vendored on | node v24.4.1 · npm 11.4.2 |

**The archive hash and the active-manifest fingerprint are different values by
design.** The first covers the archive bytes including `export/` and archives;
the second covers the active package files and is what `audit.json` binds to.
Never present one as the other.

## Deviations from the master plan's file list

- `spec/matrices.js` **does not exist** in the package. `MATRICES` (9 rows) is
  exported from `spec/flows.js` alongside `FLOWS` (13 rows), so `flows.js` is
  vendored and the verifier reads both from it.
- `export/ZIP-SHA256.txt` ships as `.txt`, not `.md`. Copied under its real name.
- React/ReactDOM/Babel and the WOFF2 fonts were deliberately **not** copied; the
  verifier fails if any vendor binary appears here.

## Hash manifest

Every row is re-verified by `npm run zero-base:contract:verify`.

| File | SHA-256 |
|---|---|
| `export/ACCEPTANCE.md` | `b25d42c3edccbeb055885800e8a6f354cbc1f6b443c7583ea2133040da039b88` |
| `export/CHANGELOG.md` | `81bbb4d753d7fe9efa98559e8dce7fda9c042fdc135adb2ed3b82b8026da3b75` |
| `export/ZIP-SHA256.txt` | `641ebd002859d32c3485611752ba76d29dadbd49d90d37a09ca123b8715b8bb5` |
| `export/artifact-index.json` | `74628082b944bf279c49b8fb894a10c72acc50d58ea7690d9a1c3a5cfdd3d8f8` |
| `export/audit.json` | `0cde9ee8b408cd87bcde4ec0dfa2937a8690192532fd929cdd66e2dba246fbdd` |
| `export/instrumentation-ledger.json` | `b07421a30fec16ef0273795616a93a11a6ebe852968a41e974c24a851c438956` |
| `export/interaction-manifest.json` | `9673ac631645fadc8ef428d8f84249b393865107f6ede7d57fd03ab9cf208596` |
| `export/reconciliation.json` | `9b992f1c2ea0593b8ac6eda41009e7f90d942262c3a6f685ff4533209c9d2e0d` |
| `export/report-catalog.json` | `5b823c131db214ec7bbe6746f47c1692744b6a5bc2910c7981ccc251c5c51169` |
| `export/sitemap.json` | `558f626b5448eb2172042789bae6d4378eca86366eed8e0789c045e99f877c2a` |
| `spec/brief-crib.md` | `bfcdee778d0c3d37fc6c780dabe09a454604507fff91d5a710d549521b0700c7` |
| `spec/capabilities.js` | `8dd40cc8ab85ad8e5a91061c4be60261413d40386424c1ef526a0502c350da99` |
| `spec/flows.js` | `6a564d5a58a832abb43236dc47e977eeb96257b19382546b2d40b22caa884cb4` |
| `spec/invariants.js` | `bfa7c49c9d758478f150f58f08804f6b29c1453dea91a27834626e783a3c9d80` |
| `spec/semantics.js` | `be99cf2561aeb202cbae5858d5210cfb45c1dc89539ca9252342fa06140e2ef9` |

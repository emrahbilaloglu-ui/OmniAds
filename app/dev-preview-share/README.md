# Public share development preview

This route is a local visual and interaction harness for the anonymous public
creative-share surface. It returns `404` when `NODE_ENV=production` and never
reads or writes the application database.

Useful local states:

- `/dev-preview-share` — creator-safe default (`creative_team`)
- `/dev-preview-share?audience=buyer` — buyer metrics, action ledger and CSV
- `/dev-preview-share?audience=external` — external creator-safe projection
- `/dev-preview-share?state=real` — catalog-only degraded media state
- `/dev-preview-share?state=empty` — empty snapshot
- `/dev-preview-share?state=gone` — unavailable link

The CSV route uses the same public serializer as the real share. Notes are
kept only in the running development server process and reset when it restarts.

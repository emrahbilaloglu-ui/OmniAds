# Compact native coverage metadata (D173)

This versioned metadata transport preserves full original evidence and current
execution-authority boundaries. It changes no engine epoch, resolver, canonical
input/hash, clock, buyerAction or row-level brief. D172 separately aligns the
finite maintenance assessor with the business fence's proven aggregate accounting.

Catalog v4 carries one compressed original coverage root and at most16 original
fragments. The root is at most2MiB decoded and512KiB gzip, with exact length/SHA
and canonical base64. Every existing complete-original membership, schema,
manifest and original row-byte check still runs. GCM binds the explicit new
encoding. The catalog's1MiB, routed leaf944KiB, request wire1MiB, root/shard32KiB,
2MiB encrypted object and8MiB decoded evidence limits stay unchanged. The metadata
cache counts decoded v4 cost separately from request wire bytes; values over its
2MiB budget are verified without caching. A cache limit is not a peak-heap SLA.

Legacy catalogs/envelopes remain unchanged and readable. The packaging helper
uses v4 only through its explicit option; the existing collector and finite
operator still refuse originals over1134 rows. Offboarding understands decoded
ownership and preserves surviving original encoded carriers and encrypted bytes.

This release alone installs no periodic archival executor and removes no source.
A subsequent bounded caller must prove real generation size, exact runtime/source,
all retained-snapshot/FK/non-FK/reuse/parent closure, separate durable copies,
independent full-DDL restore and HTTP serving before exact source retirement.
It must also preserve business erasure as archive history grows, avoid quadratic
catalog copying, measure actual physical/WAL/scratch reserves and compare natural
storage growth against completed archive cadence. Until those pass, long-term
storage equilibrium remains open.

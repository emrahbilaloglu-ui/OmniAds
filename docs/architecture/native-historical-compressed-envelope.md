# D139: explicit bounded compressed historical format

The first actual original-generation copy was 2,271,447 plaintext bytes and
2,271,496 v1 encrypted bytes. Its independent seven-table local restoration
preserved 351 rows, including all 171 original evaluations, exact JSONB/clock
bytes, and selected immutable calibration parents. It exceeded D136's two-MiB
runtime pilot. A lossless gzip-level-6 measurement reduced that one plaintext
to166,387 bytes. Those local observations are not a global compression ratio,
production latency guarantee, live storage or physical reclamation.

Use the additive `native-historical-aes-256-gcm-gzip.v2` envelope for complete
original packages. Its marker is `ADSECUTE_NATIVE_GZ2\0`. Gzip compresses the exact
original `JSON.stringify(bundle)` bytes before AES-256-GCM encryption. The
independent catalog and GCM authenticated data bind original plaintext length/
SHA, compressed payload length/SHA, original generation, parent manifest/schema,
and key identity. It does not rewrite row JSONB, timestamps, stored hashes,
original IDs, parent contracts or decision epochs. Encryption remains randomized;
the encrypted object's SHA is its immutable version identifier.

V1 ciphertext, AAD and catalog remain readable without migration. V1 retains its
two-MiB runtime plaintext cap and64-MiB offline cap. A v2 catalog can index legacy
and compressed entries; a v1 catalog refuses a compressed entry. V2 uses the
separate `native/v2/<ciphertext-sha>.bin` pointer. Old images refuse the additive
v2 catalog/encoding. Rollback therefore disables the historical gate or restores
the independently pinned v1 catalog; current inline evidence remains unchanged.

The compressed payload is at most two MiB (ciphertext adds fixed envelope
overhead); decoded original plaintext is at most eight MiB. The gzip decoder
sets `maxOutputLength` to the independently trusted original length BEFORE
constructing or parsing the complete plaintext. Invalid/oversized/mismatched
payloads, authentication, gzip checksum and original digests refuse. Oversized
or incompressible packages refuse rather than increasing a cap, splitting a
generation or dropping calibration parents.

Runtime admission checks both size limits before transport/allocation. Decode,
parse and full evidence validation run only in the existing compiled worker:
two concurrent validations, one per business,128-MiB old/16-MiB young V8 heaps,
four-MiB stack and five-second termination deadline. Ciphertext cache/download
budgets,256-KiB evidence responses, request/rate limits and credentials remain
unchanged. Eight-MiB native buffers and parsing/canonical-validation copies are
not a host RSS bound; local maximum-size tests are not a production SLA.

Filesystem publication preserves D138's exclusive immutable object, fsync,
exact-version/digest, same-owner/non-writable directory/object and read-only
application mount requirements. Publication does not activate the reader, change
a DB pointer or remove a source row. Every response remains historical read
only, with provider authority, current decision and reclaim eligibility false.

Before live use, require reviewed source, unchanged canonical QA, actual Node20
Linux standalone worker proof, exact image publication/deployment, fresh
capacity admission, independent durable object/catalog/key recovery, read-only
mount/readback, and original evidence/restore parity. Complete production
consumer/pin closure, measured retention population and a safe physical reclaim
unit remain separate storage gates. This format alone does not close sustainable
storage or strict positive native reuse.

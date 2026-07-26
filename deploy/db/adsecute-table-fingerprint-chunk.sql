\set ON_ERROR_STOP on

\if :{?fingerprint_table}
\else
  \echo 'fingerprint_table must be supplied'
  \quit 2
\endif
\if :{?start_block}
\else
  \echo 'start_block must be supplied'
  \quit 2
\endif
\if :{?end_block}
\else
  \echo 'end_block must be supplied'
  \quit 2
\endif
\if :{?fingerprint_explain}
\else
  \set fingerprint_explain 0
\endif

-- One bounded, resumable physical-heap chunk of an order-independent full-row
-- fingerprint. The runner holds SHARE lock while reading, so target-table DML
-- cannot overlap a chunk. Results are reduced by UUID first-byte bucket; CTID
-- ranges are only a read-progress boundary and need not match after restore.
--
-- This is a practical integrity fingerprint, not a mathematical equality
-- proof. A mismatch is followed by exact primary-key drilldown.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SET LOCAL search_path = pg_catalog, public;
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
SET LOCAL intervalstyle = 'postgres';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL lc_numeric = 'C';
SET LOCAL row_security = off;
SET LOCAL jit = off;
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL work_mem = '2MB';
SET LOCAL hash_mem_multiplier = 1.0;
-- A successful query is backend-local proof that it did not spill.
SET LOCAL temp_file_limit = 0;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';
SET LOCAL idle_in_transaction_session_timeout = '35min';
SET LOCAL enable_sort = off;
SET LOCAL enable_hashagg = on;
SET LOCAL enable_seqscan = off;
SET LOCAL enable_tidscan = on;

LOCK TABLE public.:"fingerprint_table" IN SHARE MODE NOWAIT;

\if :fingerprint_explain
EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, TIMING OFF, SUMMARY ON)
\else
COPY (
\endif
  WITH aggregated AS MATERIALIZED (
    SELECT
      bucket,
      count(*) AS row_count,
      bit_xor(a) AS xor_a,
      sum(a::numeric) AS sum_a,
      bit_xor(b) AS xor_b,
      sum(b::numeric) AS sum_b,
      bit_xor(c) AS xor_c,
      sum(c::numeric) AS sum_c,
      bit_xor(d) AS xor_d,
      sum(d::numeric) AS sum_d
    FROM (
      SELECT
        bucket,
        (('x' || encode(substring(row_hash FROM 1 FOR 8), 'hex'))::bit(64)::bigint) AS a,
        (('x' || encode(substring(row_hash FROM 9 FOR 8), 'hex'))::bit(64)::bigint) AS b,
        (('x' || encode(substring(row_hash FROM 17 FOR 8), 'hex'))::bit(64)::bigint) AS c,
        (('x' || encode(substring(row_hash FROM 25 FOR 8), 'hex'))::bit(64)::bigint) AS d
      FROM (
        SELECT
          bucket,
          digest(bytes, 'sha256') AS row_hash
        FROM (
          SELECT
            get_byte(uuid_send(id), 0) AS bucket,
            convert_to(to_jsonb(source_row)::text, 'UTF8') AS bytes
          FROM public.:"fingerprint_table" AS source_row
          WHERE ctid >= format('(%s,0)', :start_block::bigint)::tid
            AND ctid < format('(%s,0)', :end_block::bigint)::tid
          OFFSET 0
        ) AS json_rows
        OFFSET 0
      ) AS digests
      OFFSET 0
    ) AS limbs
    GROUP BY bucket
  )
  SELECT
    :start_block::bigint AS start_block,
    :end_block::bigint AS end_block,
    buckets.bucket,
    coalesce(aggregated.row_count, 0) AS row_count,
    coalesce(aggregated.xor_a, 0) AS xor_a,
    coalesce(aggregated.sum_a, 0) AS sum_a,
    coalesce(aggregated.xor_b, 0) AS xor_b,
    coalesce(aggregated.sum_b, 0) AS sum_b,
    coalesce(aggregated.xor_c, 0) AS xor_c,
    coalesce(aggregated.sum_c, 0) AS sum_c,
    coalesce(aggregated.xor_d, 0) AS xor_d,
    coalesce(aggregated.sum_d, 0) AS sum_d
  FROM generate_series(0, 255) AS buckets(bucket)
  LEFT JOIN aggregated USING (bucket)
\if :fingerprint_explain
;
\else
) TO STDOUT WITH (FORMAT csv, HEADER true);
\endif

COMMIT;

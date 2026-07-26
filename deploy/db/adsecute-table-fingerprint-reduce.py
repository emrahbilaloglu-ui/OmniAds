#!/usr/bin/env python3

import csv
import os
import re
import sys
import tempfile
from pathlib import Path


PART_HEADER = [
    "start_block",
    "end_block",
    "bucket",
    "row_count",
    "xor_a",
    "sum_a",
    "xor_b",
    "sum_b",
    "xor_c",
    "sum_c",
    "xor_d",
    "sum_d",
]
CONTRACT_VERSION = "adsecute-table-fingerprint.v2"
FINAL_HEADER = ["contract_version", *PART_HEADER[2:]]
LIMBS = ("a", "b", "c", "d")
UINT64_MASK = (1 << 64) - 1
INT64_MAX = (1 << 63) - 1
INT64_MIN = -(1 << 63)
INTEGER_PATTERN = re.compile(r"^-?[0-9]+$")
PART_NAME_PATTERN = re.compile(r"^part-([0-9]+)-([0-9]+)\.csv$")


class FingerprintError(Exception):
    pass


def fail(message):
    raise FingerprintError(message)


def parse_integer(value, label):
    if INTEGER_PATTERN.fullmatch(value) is None:
        fail("{} is not an integer".format(label))
    return int(value)


def parse_non_negative_integer(value, label):
    parsed = parse_integer(value, label)
    if parsed < 0:
        fail("{} must be non-negative".format(label))
    return parsed


def parse_csv(file_path):
    csv_path = Path(file_path)
    if csv_path.is_symlink():
        fail("{}: symbolic links are not accepted".format(csv_path))
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as input_file:
            rows = list(csv.reader(input_file, strict=True))
    except (OSError, csv.Error, UnicodeError) as error:
        fail("{}: could not read CSV: {}".format(csv_path, error))

    if not rows:
        fail("{}: empty CSV".format(csv_path))
    if rows[0] != PART_HEADER:
        fail("{}: unexpected header".format(csv_path))
    parsed_rows = []
    for line_number, values in enumerate(rows[1:], start=2):
        if not values:
            continue
        if len(values) != len(PART_HEADER):
            fail(
                "{}:{}: expected {} fields".format(
                    csv_path, line_number, len(PART_HEADER)
                )
            )
        parsed_rows.append(dict(zip(PART_HEADER, values)))
    return parsed_rows


def validate_part(file_path, expected_start=None, expected_end=None):
    rows = parse_csv(file_path)
    if len(rows) != 256:
        fail("{}: expected 256 bucket rows, found {}".format(file_path, len(rows)))

    start = parse_non_negative_integer(
        rows[0]["start_block"], "{}: start_block".format(file_path)
    )
    end = parse_non_negative_integer(
        rows[0]["end_block"], "{}: end_block".format(file_path)
    )
    if end <= start:
        fail("{}: end_block must be greater than start_block".format(file_path))
    if expected_start is not None and start != int(expected_start):
        fail(
            "{}: expected start_block {}, found {}".format(
                file_path, expected_start, start
            )
        )
    if expected_end is not None and end != int(expected_end):
        fail(
            "{}: expected end_block {}, found {}".format(
                file_path, expected_end, end
            )
        )

    buckets = set()
    parsed_rows = []
    for line_number, row in enumerate(rows, start=2):
        row_start = parse_non_negative_integer(
            row["start_block"], "{}:{}: start_block".format(file_path, line_number)
        )
        row_end = parse_non_negative_integer(
            row["end_block"], "{}:{}: end_block".format(file_path, line_number)
        )
        if row_start != start or row_end != end:
            fail("{}:{}: mixed chunk bounds".format(file_path, line_number))

        bucket = parse_non_negative_integer(
            row["bucket"], "{}:{}: bucket".format(file_path, line_number)
        )
        if bucket > 255:
            fail("{}:{}: bucket outside 0..255".format(file_path, line_number))
        if bucket in buckets:
            fail("{}:{}: duplicate bucket {}".format(file_path, line_number, bucket))
        buckets.add(bucket)

        parsed = {
            "bucket": bucket,
            "row_count": parse_non_negative_integer(
                row["row_count"],
                "{}:{}: row_count".format(file_path, line_number),
            ),
            "xor": {},
            "sum": {},
        }
        for limb in LIMBS:
            xor_value = parse_integer(
                row["xor_{}".format(limb)],
                "{}:{}: xor_{}".format(file_path, line_number, limb),
            )
            if xor_value < INT64_MIN or xor_value > INT64_MAX:
                fail(
                    "{}:{}: xor_{} outside signed bigint".format(
                        file_path, line_number, limb
                    )
                )
            parsed["xor"][limb] = xor_value & UINT64_MASK
            parsed["sum"][limb] = parse_integer(
                row["sum_{}".format(limb)],
                "{}:{}: sum_{}".format(file_path, line_number, limb),
            )
        parsed_rows.append(parsed)

    missing = sorted(set(range(256)) - buckets)
    if missing:
        fail("{}: missing bucket {}".format(file_path, missing[0]))
    return {"start": start, "end": end, "rows": parsed_rows}


def render_signed_64(value):
    normalized = value & UINT64_MASK
    return normalized - (1 << 64) if normalized > INT64_MAX else normalized


def fsync_file(file_path):
    descriptor = os.open(str(file_path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(directory):
    try:
        descriptor = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def durable_atomic_write(file_path, contents):
    requested_path = Path(file_path)
    if requested_path.is_symlink():
        fail("{}: symbolic links are not accepted".format(requested_path))
    output_path = requested_path.absolute()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".{}.".format(output_path.name),
            suffix=".part",
            dir=str(output_path.parent),
        )
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output_file:
            output_file.write(contents)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(str(temporary_path), str(output_path))
        temporary_path = None
        fsync_directory(output_path.parent)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def reduce_parts(parts_directory, total_blocks_value, output_path):
    total_blocks = parse_non_negative_integer(
        str(total_blocks_value), "total_blocks"
    )
    if total_blocks == 0:
        fail("total_blocks must be positive")

    directory = Path(parts_directory)
    if directory.is_symlink():
        fail("{}: symbolic links are not accepted".format(directory))
    try:
        entries = list(directory.iterdir())
    except OSError as error:
        fail("{}: could not list parts: {}".format(directory, error))

    parts = []
    for entry in entries:
        match = PART_NAME_PATTERN.fullmatch(entry.name)
        if match is None:
            continue
        if entry.is_symlink() or not entry.is_file():
            fail("{}: finalized part must be a regular file".format(entry))
        parts.append(
            {
                "path": entry,
                "start": int(match.group(1)),
                "end": int(match.group(2)),
            }
        )
    parts.sort(key=lambda part: part["start"])
    if not parts:
        fail("{}: no finalized part files".format(directory))

    accumulator = []
    for _ in range(256):
        accumulator.append(
            {
                "row_count": 0,
                "xor": {limb: 0 for limb in LIMBS},
                "sum": {limb: 0 for limb in LIMBS},
            }
        )

    cursor = 0
    for part_file in parts:
        if part_file["start"] != cursor:
            fail(
                "{}: chunk coverage gap or overlap at {}; next part starts {}".format(
                    directory, cursor, part_file["start"]
                )
            )
        if (
            part_file["end"] <= part_file["start"]
            or part_file["end"] > total_blocks
        ):
            fail("{}: invalid filename bounds".format(part_file["path"].name))

        part = validate_part(
            part_file["path"], part_file["start"], part_file["end"]
        )
        for row in part["rows"]:
            bucket = accumulator[row["bucket"]]
            bucket["row_count"] += row["row_count"]
            for limb in LIMBS:
                bucket["xor"][limb] ^= row["xor"][limb]
                bucket["sum"][limb] += row["sum"][limb]
        cursor = part["end"]

    if cursor != total_blocks:
        fail(
            "{}: incomplete chunk coverage; stopped at {}, expected {}".format(
                directory, cursor, total_blocks
            )
        )

    lines = [",".join(FINAL_HEADER)]
    for bucket_number, value in enumerate(accumulator):
        fields = [
            CONTRACT_VERSION,
            str(bucket_number),
            str(value["row_count"]),
        ]
        for limb in LIMBS:
            fields.extend(
                [
                    str(render_signed_64(value["xor"][limb])),
                    str(value["sum"][limb]),
                ]
            )
        lines.append(",".join(fields))
    durable_atomic_write(output_path, "{}\n".format("\n".join(lines)))
    return {"chunks": len(parts), "total_blocks": total_blocks}


def usage():
    return "\n".join(
        [
            "Usage:",
            "  adsecute-table-fingerprint-reduce.py validate-part FILE START_BLOCK END_BLOCK",
            "  adsecute-table-fingerprint-reduce.py reduce PARTS_DIR TOTAL_BLOCKS OUTPUT_CSV",
        ]
    )


def main(arguments):
    if len(arguments) == 4 and arguments[0] == "validate-part":
        result = validate_part(arguments[1], arguments[2], arguments[3])
        fsync_file(arguments[1])
        print(
            "status=ok start_block={} end_block={} buckets=256".format(
                result["start"], result["end"]
            )
        )
        return 0
    if len(arguments) == 4 and arguments[0] == "reduce":
        result = reduce_parts(arguments[1], arguments[2], arguments[3])
        print(
            "status=ok chunks={} total_blocks={}".format(
                result["chunks"], result["total_blocks"]
            )
        )
        return 0
    if len(arguments) == 1 and arguments[0] in ("--help", "-h"):
        print(usage())
        return 0
    print(usage(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (FingerprintError, OSError) as error:
        print("fingerprint reducer failed: {}".format(error), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Guard the existing managed cron caller; never invoke a sync/producer.

Inspection is the default. Apply requires an exact crontab, operator and build
identity. Credentials and command bodies never appear in receipts/errors.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time

LOCK = "/run/lock/adsecute-sync-cron.lock"
LOG = "/tmp/adsecute-sync-cron.log"
MAX_TIME = 1440  # bounded 24 minutes; the schedule remains every ten minutes
BEGIN = "# BEGIN adsecute-sync"
END = "# END adsecute-sync"


def need(value, code):
    if not value:
        raise ValueError(code)


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def plan(text, *, flock="/usr/bin/flock", lock=LOCK, log=LOG):
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == BEGIN]
    ends = [i for i, line in enumerate(lines) if line.rstrip("\r\n") == END]
    need(len(starts) == len(ends) == 1 and ends[0] == starts[0] + 2, "managed_block_shape_refused")
    i, j = starts[0], ends[0]
    line = lines[i + 1].rstrip("\r\n")
    prefix = "*/10 * * * * "
    need(line.startswith(prefix), "schedule_refused")
    body = line[len(prefix):]
    # Already installed is inspectable, but it is never silently reapplied.
    outer = shlex.split(body)
    guarded = outer[:7] == [flock, "-n", "-E", "75", lock, "/bin/sh", "-c"]
    if guarded:
        need(len(outer) == 8, "guarded_command_shape_refused")
        body = outer[7]
    need(not any(c in body for c in ["\n", "\r", "`", "$", "%", ";", "|"]), "dynamic_command_refused")
    match = re.fullmatch(r"(.+?)\s*>\s*" + re.escape(log) + r"\s+2>&1", body)
    need(match, "log_redirect_refused")
    curl_text = match[1]
    args = shlex.split(curl_text)
    need(len(args) == 9 and args[0] in ["curl", "/usr/bin/curl"], "curl_shape_refused")
    need(args[1:3] == ["-fsS", "-m"] and args[4:6] == ["-X", "POST"] and args[7] == "-H", "curl_arguments_refused")
    need(args[6] == "http://127.0.0.1:3000/api/sync/cron", "endpoint_refused")
    need(args[3] == str(MAX_TIME if guarded else 300), "timeout_refused")
    header = re.fullmatch(r"Authorization: Bearer ([A-Za-z0-9._~+/=\-]{16,})", args[8])
    need(header, "authorization_shape_refused")
    # Rebuild only the verified fixed invocation, retaining its exact endpoint,
    # method, token and output path. Keep the double-quoted Bearer header: the
    # existing cutover adoption guard independently verifies that exact token.
    inner = (args[0] + " -fsS -m " + str(MAX_TIME) + " -X POST " + args[6]
             + ' -H "Authorization: Bearer ' + header[1] + '" >' + log + " 2>&1")
    command = shlex.join([flock, "-n", "-E", "75", lock, "/bin/sh", "-c", inner])
    replacement_lines = lines.copy()
    replacement_lines[i + 1] = prefix + command + "\n"
    replacement = "".join(replacement_lines)
    outside = "".join(lines[:i] + lines[j + 1:])
    receipt = {"accepted": True, "currentCrontabSha256": sha(text),
               "proposedCrontabSha256": sha(replacement), "outsideSha256": sha(outside),
               "currentBlockSha256": sha("".join(lines[i:j + 1])),
               "proposedBlockSha256": sha("".join(replacement_lines[i:j + 1])),
               "alreadyGuarded": guarded, "scheduleUnchanged": True,
               "methodEndpointCredentialAndLogUnchanged": True,
               "clientMaxSecondsBefore": int(args[3]), "clientMaxSecondsAfter": MAX_TIME,
               "overlapExitCode": 75, "redirectInsideLock": True,
               "observedAtUnix": time.time(), "rawCommandsOrCredentialsStored": False}
    return replacement, receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-crontab-sha")
    parser.add_argument("--expected-operator-sha")
    parser.add_argument("--expected-build")
    args = parser.parse_args()
    need(sys.platform == "linux" and os.geteuid() == 0, "linux_root_required")
    current = subprocess.run(["crontab", "-l"], check=True, capture_output=True, text=True, timeout=10).stdout
    replacement, receipt = plan(current)
    receipt.update(inspectOnly=not args.apply, noProducerInvoked=True)
    if args.apply:
        need(sha(current) == args.expected_crontab_sha, "crontab_changed")
        need(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == args.expected_operator_sha, "operator_identity_mismatch")
        need(re.fullmatch(r"[a-f0-9]{40}", args.expected_build or ""), "build_required")
        need(Path("/usr/bin/flock").is_file(), "flock_unavailable")
        version = subprocess.run(["/usr/bin/flock", "--version"], check=True, capture_output=True, text=True, timeout=5).stdout
        need("util-linux" in version, "flock_implementation_refused")
        for role in ["web", "worker", "archive-erasure"]:
            container = subprocess.run(["docker", "compose", "ps", "-q", role], cwd="/var/www/adsecute", capture_output=True, text=True, check=True, timeout=10).stdout.strip()
            obj = json.loads(subprocess.run(["docker", "inspect", container], capture_output=True, text=True, check=True, timeout=10).stdout)[0]
            env = dict(x.split("=", 1) for x in obj["Config"]["Env"] if "=" in x)
            need(env.get("APP_BUILD_ID") == obj["Config"]["Labels"].get("org.opencontainers.image.revision") == args.expected_build, "runtime_identity_mismatch")
            need(obj["State"].get("Health", {}).get("Status") == "healthy", "runtime_not_healthy")
            if role == "web":
                secret = env.get("CRON_SECRET", "")
                need(secret and ('Bearer ' + secret + '"') in replacement, "current_credential_mismatch")
        need(not receipt["alreadyGuarded"], "already_guarded_no_mutation")
        lock = Path(LOCK)
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            st = os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, "unsafe_lock_file")
        finally:
            os.close(fd)
        directory = Path("/var/lib/adsecute-sync-cron-receipts")
        directory.mkdir(mode=0o700, exist_ok=True)
        st = directory.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o077, "unsafe_backup_directory")
        backup = directory / (str(time.time_ns()) + ".crontab")
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as out:
            out.write(current)
            out.flush()
            os.fsync(out.fileno())
        # Recheck after preflight/backup, before the one authorized write.
        fresh = subprocess.run(["crontab", "-l"], check=True, capture_output=True, text=True, timeout=10).stdout
        need(fresh == current, "crontab_changed_before_apply")
        subprocess.run(["crontab", "-"], input=replacement, check=True, capture_output=True, text=True, timeout=10)
        actual = subprocess.run(["crontab", "-l"], check=True, capture_output=True, text=True, timeout=10).stdout
        need(actual == replacement, "independent_crontab_readback_failed")
        receipt.update(applied=True, readbackPassed=True, backupPath=str(backup), build=args.expected_build)
    print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z_]+", str(error)) else "caller_operation_failed"
        print(json.dumps({"accepted": False, "code": code, "noProducerInvoked": True}), file=sys.stderr)
        sys.exit(1)

# Runs ON THE APP HOST over a NON-forwarding connection. Read-only census of the
# processes that still depend on the forwarded credential.
#
# Step 2 of ordered shutdown (requirement 2): the bounded wait polls this until
# the remote side is provably terminal. Only then may the credential be closed.
# "Provably" matters — an unreadable /proc must not be reported as zero, because
# zero is the answer that authorises withdrawing the credential.
set -uo pipefail

W=0
R=0
UNKNOWN=0

for p in $(pgrep -f 'hetzner-sync-cutover' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  C=""
  if [ -r "/proc/$p/cmdline" ]; then
    C="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
  elif ps -p "$p" >/dev/null 2>&1; then
    C="$(ps -o command= -p "$p" 2>/dev/null)"
  fi
  case "${C}" in
    "")        UNKNOWN=$((UNKNOWN + 1)) ;;
    *pgrep*)   continue ;;
    *hetzner-sync-cutover*) W=$((W + 1)) ;;
  esac
done

for p in $(pgrep -f 'pg_dump|pg_restore|pg_basebackup' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  C=""
  if [ -r "/proc/$p/cmdline" ]; then
    C="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)"
  elif ps -p "$p" >/dev/null 2>&1; then
    C="$(ps -o command= -p "$p" 2>/dev/null)"
  fi
  case "${C}" in
    "")        UNKNOWN=$((UNKNOWN + 1)) ;;
    *pgrep*)   continue ;;
    *pg_dump*|*pg_restore*|*pg_basebackup*) R=$((R + 1)) ;;
  esac
done

printf 'wrappers=%s writers=%s unidentified=%s\n' "${W}" "${R}" "${UNKNOWN}"
if [ "${W}" = "0" ] && [ "${R}" = "0" ] && [ "${UNKNOWN}" = "0" ]; then
  printf 'REMOTE_STATE=TERMINAL\n'
else
  printf 'REMOTE_STATE=LIVE\n'
fi

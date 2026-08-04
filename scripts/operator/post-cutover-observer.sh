#!/bin/bash
# Durable read-only observation of the post-cutover release.
#
# Writes one line per tick to /var/log/adsecute-cutover-observation.log. It
# mutates nothing except its own log, its own window marker, and — when the
# window completes — its own timer.
#
# WINDOW SEMANTICS
# The governing Goal requires 24 UNINTERRUPTED hours: "manual intervention or
# unresolved internal failure resets the window". So an anomalous tick rewrites
# the window start to now, and the clock begins again. A window can therefore
# only complete after 24h in which every tick was clean.
set -uo pipefail

EXPECT_SHA=f77c1dd28f01ad6bfd53ac7286d5ef2e476761fa
ENVF=/var/www/adsecute/.env.production
LOG=/var/log/adsecute-cutover-observation.log
START=/var/lib/adsecute-cutover/observation-window-start
WINDOW=86400

now="$(date -u +%s)"
iso="$(date -u -d "@${now}" +%Y-%m-%dT%H:%M:%SZ)"
A=""   # accumulated anomaly reasons
note() { A="${A}${A:+; }$1"; }

# ── services ──────────────────────────────────────────────────────────────
cs=""
for c in adsecute-web-1 adsecute-worker-1 adsecute-autoheal-1; do
  r="$(docker inspect "$c" --format '{{.State.Running}}' 2>/dev/null || echo false)"
  h="$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null || echo none)"
  cs="${cs}${c##adsecute-}=${r}/${h} "
  [ "$r" = true ] && [ "$h" = healthy ] || note "${c} running=${r} health=${h}"
done
web_img="$(docker inspect adsecute-web-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo none)"
wk_img="$(docker inspect adsecute-worker-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo none)"
[ "$web_img" = "$EXPECT_SHA" ] || note "web revision ${web_img}"
[ "$wk_img" = "$EXPECT_SHA" ] || note "worker revision ${wk_img}"

# ── endpoints ─────────────────────────────────────────────────────────────
hz="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://adsecute.com/api/healthz 2>/dev/null || echo 000)"
hm="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://adsecute.com/ 2>/dev/null || echo 000)"
[ "$hz" = 200 ] || note "healthz=${hz}"
[ "$hm" = 200 ] || note "home=${hm}"
bid="$(curl -s -m 20 https://adsecute.com/api/build-info 2>/dev/null | sed -n 's/.*"buildId":"\([0-9a-f]*\)".*/\1/p' | head -1)"
[ "$bid" = "$EXPECT_SHA" ] || note "build-info buildId=${bid:-unreadable}"

# ── lanes (counts only, never values) ─────────────────────────────────────
# NB: `grep -c` prints the count AND exits non-zero when that count is zero, so
# `grep -c ... || echo -1` yields a two-line value. The count alone is correct;
# this script does not use `set -e`, so a non-zero grep here is harmless.
len="$(grep -acE '^ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED=enabled' "$ENVF" 2>/dev/null)"
lret="$(grep -acE '^ADSECUTE_SYNC_LANE_RETENTION_ENABLED=enabled' "$ENVF" 2>/dev/null)"
[ -n "$len" ] || len=-1
[ -n "$lret" ] || lret=-1
[ "$len" = 7 ] || note "lanes_enabled=${len} (expected 7)"
[ "$lret" = 0 ] || note "retention_enabled=${lret} (expected 0)"

# ── scheduler ─────────────────────────────────────────────────────────────
cron_up="$(pgrep -x cron >/dev/null && echo yes || echo no)"
[ "$cron_up" = yes ] || note "cron not running"
sync_age=-1
if [ -f /tmp/adsecute-sync-cron.log ]; then
  sync_age=$(( now - $(stat -c %Y /tmp/adsecute-sync-cron.log) ))
fi
# the */10 job should touch it well inside 20 minutes
[ "$sync_age" -ge 0 ] && [ "$sync_age" -le 1500 ] || note "sync cron log age=${sync_age}s"

# ── disk ──────────────────────────────────────────────────────────────────
duse="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
[ "${duse:-100}" -lt 85 ] || note "root disk ${duse}%"

# ── database-side facts ───────────────────────────────────────────────────
DBQ="" ; DBOK=no
DU="$(grep -a '^DATABASE_URL=' "$ENVF" 2>/dev/null | head -1 | sed 's/^DATABASE_URL=//' | tr -d '"'"'"'')"
if [ -n "$DU" ]; then
  DBQ="$(psql "$DU" -t -A -F'|' -v ON_ERROR_STOP=1 -c "
    SELECT
      (SELECT count(*) FROM sync_runtime_instances
         WHERE last_seen_at > now() - interval '10 minutes' AND build_id <> '${EXPECT_SHA}'),
      (SELECT count(*) FROM sync_worker_heartbeats
         WHERE last_heartbeat_at > now() - interval '10 minutes'),
      (SELECT count(*) FROM sync_runner_leases WHERE lease_expires_at > now()),
      (SELECT count(*) FROM sync_incidents
         WHERE cleared_at IS NULL AND manual_required_at IS NOT NULL),
      (SELECT COALESCE(round(EXTRACT(EPOCH FROM (now()-max(sampled_at)))),-1)
         FROM system_capacity_snapshots WHERE source='db_host_healthcheck'),
      (SELECT COALESCE(round(EXTRACT(EPOCH FROM (now()-max(latest_successful_sync_at)))/60),-1) FROM meta_sync_state),
      (SELECT COALESCE(round(EXTRACT(EPOCH FROM (now()-max(latest_successful_sync_at)))/60),-1) FROM google_ads_sync_state),
      (SELECT COALESCE(round(EXTRACT(EPOCH FROM (now()-max(latest_successful_sync_at)))/60),-1) FROM shopify_sync_state),
      (SELECT count(*) FROM (SELECT business_id,provider_account_id,scope FROM meta_sync_state GROUP BY 1,2,3 HAVING count(*)>1) a),
      (SELECT count(*) FROM (SELECT business_id,provider_account_id,scope FROM google_ads_sync_state GROUP BY 1,2,3 HAVING count(*)>1) b),
      (SELECT count(*) FROM (SELECT business_id,provider_account_id,sync_target FROM shopify_sync_state GROUP BY 1,2,3 HAVING count(*)>1) c),
      (SELECT count(*) FROM meta_sync_state s LEFT JOIN businesses x ON x.id::text=s.business_id::text WHERE x.id IS NULL)
  ;" 2>/dev/null)"
  [ -n "$DBQ" ] && DBOK=yes
fi

if [ "$DBOK" = yes ]; then
  IFS='|' read -r old_builds hb leases manual capage meta_m goog_m shop_m dm dg ds orph <<< "$DBQ"
  [ "${old_builds:-1}" = 0 ]      || note "old-build instances alive=${old_builds}"
  [ "${hb:-0}" -ge 1 ]            || note "no worker heartbeat in 10m"
  [ "${manual:-1}" = 0 ]          || note "incidents needing manual action=${manual}"
  [ "${capage:-99999}" -ge 0 ] && [ "${capage:-99999}" -le 2100 ] || note "db capacity sample age=${capage}s (db-host timer)"
  [ "${dm:-1}" = 0 ] && [ "${dg:-1}" = 0 ] && [ "${ds:-1}" = 0 ] || note "duplicate sync-state rows meta=${dm} google=${dg} shopify=${ds}"
  [ "${orph:-1}" = 0 ]            || note "orphan business refs=${orph}"
else
  note "database probe failed"
  old_builds=? ; hb=? ; leases=? ; manual=? ; capage=? ; meta_m=? ; goog_m=? ; shop_m=? ; dm=? ; dg=? ; ds=? ; orph=?
fi

# ── window bookkeeping ────────────────────────────────────────────────────
[ -f "$START" ] || printf '%s\n' "$now" > "$START"
ws="$(cat "$START" 2>/dev/null || echo "$now")"
case "$ws" in ''|*[!0-9]*) ws="$now"; printf '%s\n' "$now" > "$START" ;; esac
elapsed=$(( now - ws ))

if [ -n "$A" ]; then
  verdict=ANOMALY
  printf '%s\n' "$now" > "$START"     # unresolved failure restarts the 24h clock
  elapsed=0
elif [ "$elapsed" -ge "$WINDOW" ]; then
  verdict=WINDOW_COMPLETE
else
  verdict=OK
fi

printf '%s verdict=%s elapsed_s=%s containers=%s healthz=%s home=%s build=%s lanes=%s retention=%s cron=%s sync_log_age=%s disk=%s%% old_builds=%s heartbeats_10m=%s live_leases=%s manual_incidents=%s cap_sample_age=%s meta_min=%s google_min=%s shopify_min=%s dupes=%s/%s/%s orphans=%s%s\n' \
  "$iso" "$verdict" "$elapsed" "${cs% }" "$hz" "$hm" "${bid:0:12}" "$len" "$lret" "$cron_up" "$sync_age" "$duse" \
  "$old_builds" "$hb" "$leases" "$manual" "$capage" "$meta_m" "$goog_m" "$shop_m" "$dm" "$dg" "$ds" "$orph" \
  "${A:+ anomalies=[${A}]}" >> "$LOG"
chmod 0600 "$LOG" 2>/dev/null

if [ "$verdict" = WINDOW_COMPLETE ]; then
  printf '%s 24-HOUR OBSERVATION COMPLETE — every tick clean since %s\n' \
    "$iso" "$(date -u -d "@${ws}" +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG"
  systemctl stop adsecute-cutover-observer.timer 2>/dev/null
  systemctl disable adsecute-cutover-observer.timer 2>/dev/null
fi
exit 0

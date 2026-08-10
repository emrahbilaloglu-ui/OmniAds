"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Database, HardDrive, RefreshCw, Server } from "lucide-react";
import type {
  AdminDiskCapacity,
  AdminSystemCapacityPayload,
  SystemCapacityStatus,
} from "@/lib/admin-system-capacity";

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 1;
  return `${nextValue.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDiskBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let nextValue = value;
  let unitIndex = 0;
  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex <= 1 ? 0 : 1;
  return `${nextValue.toFixed(digits)} ${units[unitIndex]}`;
}

function displayTotalBytes(disk: AdminDiskCapacity) {
  const measuredTotal =
    disk.usedBytes != null && disk.availableBytes != null
      ? disk.usedBytes + disk.availableBytes
      : null;

  if (disk.totalBytes == null || !Number.isFinite(disk.totalBytes)) {
    return measuredTotal;
  }

  if (
    measuredTotal != null &&
    Number.isFinite(measuredTotal) &&
    measuredTotal > 0 &&
    disk.totalBytes > measuredTotal * 1.2
  ) {
    return measuredTotal;
  }

  return disk.totalBytes;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function statusLabel(status: SystemCapacityStatus) {
  if (status === "ok") return "Normal";
  if (status === "warning") return "Uyarı";
  if (status === "critical") return "Kritik";
  return "Bilinmiyor";
}

function statusClass(status: SystemCapacityStatus) {
  if (status === "ok") return "bg-emerald-100 text-emerald-700";
  if (status === "warning") return "bg-amber-100 text-amber-700";
  if (status === "critical") return "bg-red-100 text-red-700";
  return "bg-gray-100 text-gray-700";
}

function progressClass(status: SystemCapacityStatus) {
  if (status === "critical") return "bg-red-500";
  if (status === "warning") return "bg-amber-500";
  if (status === "ok") return "bg-emerald-500";
  return "bg-gray-300";
}

function relationKindLabel(kind: string) {
  if (kind === "materialized_view") return "Mat. view";
  if (kind === "table") return "Table";
  return kind;
}

function findDbVolumeDisk(disks: AdminDiskCapacity[]) {
  return (
    disks.find((disk) => disk.path === "/var/lib/postgresql") ??
    disks.find((disk) => disk.mountedOn === "/var/lib/postgresql") ??
    disks.find((disk) => disk.mountedOn === "/mnt/HC_Volume_105661509") ??
    disks.find((disk) => disk.status !== "unknown") ??
    disks[0] ??
    null
  );
}

function findRuntimePrimaryDisk(disks: AdminDiskCapacity[]) {
  return (
    disks.find((disk) => disk.path === "/") ??
    disks.find((disk) => disk.mountedOn === "/") ??
    disks.find((disk) => disk.status !== "unknown") ??
    disks[0] ??
    null
  );
}

function runtimePanelTitle(payload: AdminSystemCapacityPayload) {
  if (payload.runtimeIsProdServer || payload.runtimeDiskSource === "prod_host_ssh") {
    return "Adsecute Prod Sunucu Kapasitesi";
  }
  if (payload.runtimePlatform === "darwin") return "Local Runtime Disk Kapasitesi";
  if (payload.runtimeHost?.toLowerCase().includes("adsecute-prod")) {
    return "Adsecute Prod Sunucu Kapasitesi";
  }
  return "Web Runtime Disk Kapasitesi";
}

function runtimeSourceLabel(payload: AdminSystemCapacityPayload) {
  if (payload.runtimeDiskSource === "prod_host_ssh") return "Prod host SSH df";
  if (payload.runtimePlatform === "darwin") return "Local macOS df";
  return "Web runtime df";
}

function combineDiskStatuses(disks: AdminDiskCapacity[]): SystemCapacityStatus {
  if (!disks.length) return "unknown";
  const statuses = disks.map((disk) => disk.status);
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  if (statuses.every((status) => status === "unknown")) return "unknown";
  if (statuses.includes("unknown")) return "warning";
  return "ok";
}

function StatusBadge({ status }: { status: SystemCapacityStatus }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

function MetricTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-gray-50 p-2">{icon}</div>
        <div>
          <p className="text-xs font-medium text-gray-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500">{detail}</p>
    </div>
  );
}

function DiskCapacityPanel({
  title,
  subtitle,
  disks,
  emptyText,
}: {
  title: string;
  subtitle: string;
  disks: AdminDiskCapacity[];
  emptyText: string;
}) {
  const panelStatus = combineDiskStatuses(disks);

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
            <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>
          </div>
          <StatusBadge status={panelStatus} />
        </div>
      </div>
      <div className="divide-y divide-gray-100">
        {disks.length === 0 ? (
          <div className="px-5 py-4 text-sm text-gray-500">{emptyText}</div>
        ) : (
          disks.map((disk) => (
            <div
              key={`${disk.source}-${disk.host ?? "runtime"}-${disk.path}-${disk.mountedOn ?? "mount"}`}
              className="px-5 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{disk.path}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {disk.host ? `${disk.host} • ` : ""}{disk.filesystem ?? "filesystem unknown"} • {disk.mountedOn ?? "mount unknown"}
                  </p>
                </div>
                <StatusBadge status={disk.status} />
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full ${progressClass(disk.status)}`}
                  style={{ width: `${Math.min(Math.max(disk.usedPercent ?? 0, 0), 100)}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{disk.usedPercent ?? "—"}%</p>
                  <p className="text-[12px] text-gray-500">Kullanım</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{formatDiskBytes(displayTotalBytes(disk))}</p>
                  <p className="text-[12px] text-gray-500">Toplam</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{formatDiskBytes(disk.usedBytes)}</p>
                  <p className="text-[12px] text-gray-500">Dolu</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{formatDiskBytes(disk.availableBytes)}</p>
                  <p className="text-[12px] text-gray-500">Boş</p>
                </div>
              </div>
              {disk.error ? (
                <p className="mt-3 text-xs text-amber-700">Kaynak okunamadı: {disk.error}</p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function AdminSystemCapacityPage() {
  const [payload, setPayload] = useState<AdminSystemCapacityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadCapacity(nextRefreshing = false) {
    if (nextRefreshing) setRefreshing(true);
    try {
      const response = await fetch("/api/admin/system-capacity", {
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (body as { message?: string } | null)?.message ??
            "System capacity could not be loaded.",
        );
      }
      setPayload(body as AdminSystemCapacityPayload);
      setLoadError(null);
    } catch (error) {
      setPayload(null);
      setLoadError(error instanceof Error ? error.message : "System capacity could not be loaded.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadCapacity();
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-400">
        Yükleniyor...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Capacity</h1>
          <p className="mt-1 text-sm text-gray-500">DB boyutu, DB host ve web runtime disk kapasitesi</p>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4">
          <p className="text-sm font-medium text-red-800">Kapasite verisi yüklenemedi.</p>
          <p className="mt-1 text-sm text-red-700">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!payload) return null;

  const dbHostDisks = payload.dbHostDisks?.length ? payload.dbHostDisks : payload.disks;
  const runtimeDisks = payload.runtimeDisks ?? [];
  const primaryDisk = findDbVolumeDisk(dbHostDisks);
  const runtimePrimaryDisk = findRuntimePrimaryDisk(runtimeDisks);
  const largestRelation = payload.database.topRelations[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-slate-100 p-2">
            <Server className="h-5 w-5 text-slate-700" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">System Capacity</h1>
            <p className="mt-1 text-sm text-gray-500">
              DB boyutu, DB host diskleri, web runtime diskleri ve en büyük tablolar
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={payload.status} />
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
            {formatDateTime(payload.sampledAt)}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
            {payload.diskSource === "db_host_healthcheck" ? "DB host" : "Local runtime"}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
            {payload.runtimeIsProdServer || payload.runtimeDiskSource === "prod_host_ssh"
              ? "Prod sunucu"
              : payload.runtimePlatform === "darwin"
                ? "Local runtime"
                : "Web runtime"}
          </span>
          <button
            type="button"
            onClick={() => void loadCapacity(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Yenile
          </button>
        </div>
      </div>

      {payload.notes.length > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            {payload.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Database className="h-4 w-4 text-indigo-600" />}
          label="DB Boyutu"
          value={payload.database.sizePretty}
          detail={`${payload.database.databaseName} • ${payload.database.userName}`}
        />
        <MetricTile
          icon={<HardDrive className="h-4 w-4 text-emerald-600" />}
          label="DB Volume Kullanımı"
          value={primaryDisk?.usedPercent == null ? "—" : `${primaryDisk.usedPercent}%`}
          detail={
            primaryDisk?.host
              ? `${primaryDisk.host} • ${primaryDisk.path}`
              : primaryDisk?.path ?? "Path okunamadı"
          }
        />
        <MetricTile
          icon={<HardDrive className="h-4 w-4 text-sky-600" />}
          label="DB Volume Boş Alan"
          value={formatDiskBytes(primaryDisk?.availableBytes)}
          detail={
            primaryDisk
              ? `Toplam ${formatDiskBytes(displayTotalBytes(primaryDisk))} • ${primaryDisk.mountedOn ?? "Mount bilinmiyor"}`
              : "Mount bilinmiyor"
          }
        />
        <MetricTile
          icon={<Database className="h-4 w-4 text-amber-600" />}
          label="En Büyük DB Tablosu"
          value={largestRelation ? formatBytes(largestRelation.totalBytes) : "—"}
          detail={largestRelation ? `${largestRelation.schema}.${largestRelation.relation}` : "Tablo verisi yok"}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="rounded-xl border border-gray-200 bg-white xl:col-span-3">
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">DB Tablo Boyutları</h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  {payload.database.serverAddress ?? "server unknown"}:{payload.database.serverPort ?? "—"}
                </p>
              </div>
              <StatusBadge status="ok" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-3 text-left">Relation</th>
                  <th className="px-5 py-3 text-left">Type</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Table</th>
                  <th className="px-5 py-3 text-right">Index</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {payload.database.topRelations.map((relation) => (
                  <tr key={`${relation.schema}.${relation.relation}`}>
                    <td className="px-5 py-3 font-medium text-gray-900">
                      {relation.schema}.{relation.relation}
                    </td>
                    <td className="px-5 py-3 text-gray-500">{relationKindLabel(relation.relationKind)}</td>
                    <td className="px-5 py-3 text-right text-gray-900">{formatBytes(relation.totalBytes)}</td>
                    <td className="px-5 py-3 text-right text-gray-500">{formatBytes(relation.tableBytes)}</td>
                    <td className="px-5 py-3 text-right text-gray-500">{formatBytes(relation.indexBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6 xl:col-span-2">
          <DiskCapacityPanel
            title="DB Host Disk Kapasitesi"
            subtitle={`${payload.diskSource === "db_host_healthcheck" ? `DB healthcheck • ${formatDateTime(payload.diskSnapshotAt)}` : "DB healthcheck yok; runtime fallback"} • Uyarı ${payload.thresholds.warningPercent}% • Kritik ${payload.thresholds.criticalPercent}%`}
            disks={dbHostDisks}
            emptyText="DB host disk verisi yok."
          />
          <DiskCapacityPanel
            title={runtimePanelTitle(payload)}
            subtitle={`${runtimeSourceLabel(payload)} • ${payload.runtimeHost ?? "host unknown"} • ${runtimePrimaryDisk?.mountedOn ?? runtimePrimaryDisk?.path ?? "mount unknown"} • Uyarı ${payload.thresholds.warningPercent}% • Kritik ${payload.thresholds.criticalPercent}%`}
            disks={runtimeDisks}
            emptyText="Web runtime disk verisi yok."
          />
        </div>
      </div>
    </div>
  );
}

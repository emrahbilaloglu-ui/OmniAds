import { parentPort, workerData } from "node:worker_threads";
import { openNativeHistoricalArchiveEvidence } from "@/lib/creative-decision-engine/native-historical-archive";
import { assertNativeHistoricalRuntimeObjectBound, NATIVE_HISTORICAL_READ_BOUNDS } from "./native-historical-read-controls";

// Dedicated bounded worker, never the Next request event loop. No provider or DB
// credentials are inherited. Only encrypted bytes and this object's decryption key
// enter the worker, and only a bounded verified original evidence response leaves.
try {
  assertNativeHistoricalRuntimeObjectBound(workerData.entry);
  if (workerData.bytes.byteLength !== workerData.entry.ciphertextBytes || workerData.key.byteLength !== 32)
    throw new Error("worker input bound");
  const value = openNativeHistoricalArchiveEvidence(new Uint8Array(workerData.bytes), workerData.entry,
    new Uint8Array(workerData.key), workerData.request);
  if (Buffer.byteLength(JSON.stringify(value)) > NATIVE_HISTORICAL_READ_BOUNDS.maxResponseBytes) throw new Error("response bound");
  parentPort!.postMessage({ ok: true, value });
} catch {
  parentPort!.postMessage({ ok: false });
}

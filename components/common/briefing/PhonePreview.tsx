"use client";

import { Play } from "lucide-react";
import type { ReactNode } from "react";

export type PhonePreviewShape = "portrait" | "square";
export type PhonePreviewFormat = "VID" | "IMG" | "CAR";
export type PhonePreviewPlacement = "reels" | "feed" | "stories";

interface PhonePreviewProps {
  shape: PhonePreviewShape;
  format: PhonePreviewFormat;
  name: string;
  meta?: string;
  placement?: PhonePreviewPlacement;
  imageUrl?: string | null;
  testId?: string;
  footer?: ReactNode;
}

const PLACEMENT_LABELS: Record<PhonePreviewPlacement, string> = {
  reels: "Reels",
  feed: "Feed",
  stories: "Stories",
};

export function PhonePreview({
  shape,
  format,
  name,
  meta,
  placement,
  imageUrl,
  testId = "phone-preview",
  footer,
}: PhonePreviewProps) {
  const width = shape === "portrait" ? 240 : 280;
  const height = shape === "portrait" ? 480 : 280;

  return (
    <div
      className="flex flex-col items-center gap-3"
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
        {(Object.keys(PLACEMENT_LABELS) as PhonePreviewPlacement[]).map((key) => (
          <span
            key={key}
            data-active={placement === key}
            className={
              "rounded-md border px-2 py-0.5 font-semibold " +
              (placement === key
                ? "border-neutral-900 bg-neutral-900 text-white"
                : "border-neutral-200 bg-white text-neutral-600")
            }
          >
            {PLACEMENT_LABELS[key]}
          </span>
        ))}
      </div>
      <div
        className="relative overflow-hidden rounded-[36px] border-[3px] border-neutral-900 bg-neutral-950 p-1 shadow-[0_1px_2px_rgba(16,21,28,0.08)]"
        style={{ width: `${width + 16}px` }}
        aria-label={`${name} preview`}
      >
        <div className="relative h-2 w-full rounded-t-[24px] bg-neutral-950">
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-1.5 inline-block h-1.5 w-16 -translate-x-1/2 rounded-full bg-neutral-700"
          />
        </div>
        <div
          className="relative overflow-hidden rounded-[28px]"
          style={{ width: `${width}px`, height: `${height}px` }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={name}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(160deg, #a3a3a3 0%, #525252 60%, #171717 100%)",
              }}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-black/30" />
          {format === "VID" ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-white/95 text-neutral-900 shadow-[0_1px_2px_rgba(16,21,28,0.08)]">
                <Play size={22} aria-hidden="true" fill="currentColor" />
              </span>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-5xl text-white/85" aria-hidden="true">
                {format === "CAR" ? "▣" : "▭"}
              </span>
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-white">
            <div className="line-clamp-2 text-[12px] font-semibold leading-snug">
              {name}
            </div>
            {meta ? (
              <div className="line-clamp-1 text-[12px] text-white/80">
                {meta}
              </div>
            ) : null}
          </div>
          <span className="absolute right-2 top-2 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-white">
            {format} · {shape === "portrait" ? "9:16" : "1:1"}
          </span>
        </div>
        <div className="mt-1 flex justify-center">
          <span
            aria-hidden="true"
            className="block h-1 w-24 rounded-full bg-neutral-700"
          />
        </div>
      </div>
      {footer}
    </div>
  );
}

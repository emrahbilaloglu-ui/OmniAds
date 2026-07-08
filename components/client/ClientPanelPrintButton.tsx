"use client";

export function ClientPanelPrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="ad-client-outline-button"
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}

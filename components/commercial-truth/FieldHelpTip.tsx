"use client";

import { CircleHelp } from "lucide-react";
import { ReactNode, useId, useState } from "react";

import styles from "@/components/commercial-truth/FieldHelpTip.module.css";

export function FieldHelpTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={styles.root}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-label={`Explain ${label}`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            event.currentTarget.blur();
          }
        }}
      >
        <CircleHelp size={15} aria-hidden="true" />
      </button>
      <span id={tooltipId} className={styles.tooltip} role="tooltip" data-open={open} hidden={!open}>
        {children}
      </span>
    </span>
  );
}

"use client";

/**
 * Settings — the Dashboard v2 screen, rendered exactly.
 *
 * Four fields, one plan band, three action rows. The design gives the field
 * card no button, so the name persists as it is edited rather than behind a
 * save control the design does not draw.
 */
import styles from "@/components/settings/SettingsExact.module.css";
import type {
  SettingsExactModel,
  SettingsRowId,
} from "@/components/settings/settings-exact-adapter";

export interface SettingsExactProps {
  model: SettingsExactModel;
  flash: { tone: "success" | "error"; text: string } | null;
  onNameChange: (value: string) => void;
  onNameCommit: () => void;
  onLanguageChange: (value: "en" | "tr") => void;
  onRowAction: (row: SettingsRowId) => void;
  onUpgrade: () => void;
  busyRow: SettingsRowId | null;
}

export function SettingsExact({
  model,
  flash,
  onNameChange,
  onNameCommit,
  onLanguageChange,
  onRowAction,
  onUpgrade,
  busyRow,
}: SettingsExactProps) {
  return (
    <section className={styles.root} data-screen-label="Settings">
      <div>
        <p className={styles.eyebrow}>{model.eyebrow}</p>
        <h1 className={styles.title}>{model.title}</h1>
      </div>

      {flash ? (
        <p
          className={`${styles.flash} ${
            flash.tone === "success" ? styles.flashSuccess : styles.flashError
          }`}
          role="status"
        >
          {flash.text}
        </p>
      ) : null}

      <article className={styles.fieldCard}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Full name</span>
          <input
            className={styles.input}
            value={model.fullName}
            aria-label="Full name"
            onChange={(event) => onNameChange(event.target.value)}
            onBlur={onNameCommit}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Email</span>
          <input className={styles.input} value={model.email} aria-label="Email" readOnly />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Interface language</span>
          <select
            className={styles.select}
            value={model.language}
            aria-label="Interface language"
            onChange={(event) => onLanguageChange(event.target.value as "en" | "tr")}
          >
            <option value="en">English</option>
            <option value="tr">Türkçe</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Workspace timezone</span>
          <select
            className={styles.select}
            value={model.timezone}
            aria-label="Workspace timezone"
            disabled
          >
            {model.timezoneOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </article>

      <article className={styles.planBand}>
        <div className={styles.planBody}>
          <p className={styles.planTitle}>{model.plan.title}</p>
          <p className={styles.planDetail}>{model.plan.detail}</p>
        </div>
        {model.plan.action ? (
          <button type="button" className={styles.planAction} onClick={onUpgrade}>
            {model.plan.action}
          </button>
        ) : null}
      </article>

      {model.rows.map((row) => (
        <article key={row.id} className={styles.actionRow}>
          <div className={styles.actionBody}>
            <p className={styles.actionTitle}>{row.title}</p>
            <p className={styles.actionDetail}>{row.detail}</p>
          </div>
          <button
            type="button"
            className={styles.actionButton}
            style={{ borderColor: row.buttonBorder, color: row.buttonForeground }}
            disabled={busyRow === row.id}
            onClick={() => onRowAction(row.id)}
          >
            {row.button}
          </button>
        </article>
      ))}
    </section>
  );
}

export default SettingsExact;

import type { OverviewAttributionRow } from "@/src/types/models";

import styles from "./attribution-card.module.css";

const CHANNEL_LOGOS: Array<{ match: RegExp; logo: string }> = [
  { match: /meta|facebook|instagram/i, logo: "/platform-logos/Meta.png" },
  { match: /google\s*ads|adwords/i, logo: "/platform-logos/googleAds.svg" },
  { match: /klaviyo/i, logo: "/platform-logos/Klaviyo.svg" },
  {
    match: /ga4|organic|analytics|direct|referral|search/i,
    logo: "/platform-logos/GA4.svg",
  },
];

function channelLogo(channel: string, source: string) {
  const hay = `${channel} ${source}`;
  return CHANNEL_LOGOS.find((entry) => entry.match.test(hay))?.logo ?? null;
}

/** Missing figures render as an em dash — never as zero. */
function dash(value: number | null | undefined, render: (value: number) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return render(value);
}

function fixedNumber(value: number, minimumFractionDigits: number, maximumFractionDigits: number) {
  return Math.abs(value).toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits });
}

function fixedCurrency(value: number, currencySymbol: string, fractionDigits: number) {
  if (!currencySymbol) return "—";
  return `${value < 0 ? "−" : ""}${currencySymbol}${fixedNumber(value, fractionDigits, fractionDigits)}`;
}

function spendShare(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { label: "—", width: "0%" };
  }

  const bounded = Math.min(100, Math.max(0, value));
  const label = Number.isInteger(value) ? `${value}%` : `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return { label, width: `${bounded}%` };
}

function displayValues(row: OverviewAttributionRow, currencySymbol: string) {
  return {
    spend: dash(row.spend, (value) => fixedCurrency(value, currencySymbol, Math.abs(value) < 100 ? 2 : 0)),
    revenue: dash(row.revenue, (value) =>
      fixedCurrency(value, currencySymbol, Math.abs(value) < 100 ? 2 : 0),
    ),
    roas: dash(row.roas, (value) => value.toFixed(2)),
    cpa: dash(row.cpa, (value) => fixedCurrency(value, currencySymbol, 2)),
    aov: dash(row.aov, (value) => fixedCurrency(value, currencySymbol, 2)),
    conversions: dash(row.conversions, (value) => Math.round(value).toLocaleString("en-US")),
    share: spendShare(row.spendShare),
  };
}

function ChannelIdentity({ channel, logo }: { channel: string; logo: string | null }) {
  return (
    <span className="inline-flex items-center" style={{ gap: 9 }}>
      <span className="grid h-[26px] w-[26px] place-items-center rounded-[7px] border border-[var(--adv-border)] bg-[var(--adv-fill-2)]">
        <span
          role="img"
          aria-label={channel}
          className="inline-block h-[15px] w-[15px] bg-contain bg-center bg-no-repeat"
          style={{
            backgroundImage: logo ? `url(${logo})` : undefined,
          }}
        />
      </span>
      <span className="font-semibold text-[var(--adv-ink)]">{channel}</span>
    </span>
  );
}

function RoasBadge({ value, label }: { value: number | null | undefined; label: string }) {
  return (
    <span
      className="inline-flex rounded-[6px] px-[7px] py-0.5 text-[12px] font-semibold"
      style={
        value === null || value === undefined || !Number.isFinite(value)
          ? {
              background: "var(--adv-fill-2)",
              color: "var(--adv-ink-3)",
            }
          : value >= 1
            ? {
                background: "#E7F6F0",
                color: "#0b7954",
              }
            : {
                background: "#FDECF0",
                color: "#E11D48",
              }
      }
    >
      {label}
    </span>
  );
}

function ShareValue({ label, width }: { label: string; width: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-[var(--adv-hairline)]"
      >
        <span className="block h-full rounded-full bg-[var(--adv-accent)]" style={{ width }} />
      </span>
      <span className="min-w-[34px] text-[12px] text-[var(--adv-ink-3)]">{label}</span>
    </span>
  );
}

export function AttributionCard({ rows, currencySymbol }: { rows: OverviewAttributionRow[]; currencySymbol: string }) {
  return (
    <article className={`${styles.card} adv-card overflow-hidden`}>
      <div className={`${styles.header} adv-card-head`}>
        <h2 className="adv-card-title">Attribution by channel</h2>
        <div className={styles.controls}>
          <input
            placeholder="Filter channels"
            aria-label="Filter channels"
            className={styles.filter}
            style={{
              height: 30,
              borderRadius: 8,
              border: "1px solid #E4E8F0",
              background: "#F7F9FC",
              padding: "0 10px",
              fontSize: 12.5,
              outline: "none",
              fontFamily: "inherit",
              color: "#0E1526",
            }}
          />
          <button type="button" className="adv-btn adv-btn--sm">
            Columns
          </button>
        </div>
      </div>
      <div className={styles.tableViewport}>
        <table className="adv-table" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col" style={{ fontSize: 10, padding: "9px 16px" }}>
                Channel
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Spend ↓
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Revenue
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                ROAS
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                CPA
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                AOV
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Conv.
              </th>
              <th scope="col" style={{ fontSize: 10 }}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const logo = channelLogo(row.channel, row.source);
              const values = displayValues(row, currencySymbol);
              return (
                <tr key={`${row.channel}-${row.source}`} data-overview-channel={row.channel}>
                  <td style={{ padding: "11px 16px" }}>
                    <ChannelIdentity channel={row.channel} logo={logo} />
                  </td>
                  <td className="!text-[var(--adv-ink)]">{values.spend}</td>
                  <td className="!font-semibold !text-[var(--adv-ink)]">{values.revenue}</td>
                  <td>
                    <RoasBadge value={row.roas} label={values.roas} />
                  </td>
                  <td>{values.cpa}</td>
                  <td>{values.aov}</td>
                  <td>{values.conversions}</td>
                  <td>
                    <ShareValue label={values.share.label} width={values.share.width} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className={styles.mobileList} aria-label="Attribution by channel details" data-testid="attribution-cards">
        {rows.map((row) => {
          const logo = channelLogo(row.channel, row.source);
          const values = displayValues(row, currencySymbol);
          return (
            <li
              key={`${row.channel}-${row.source}`}
              className={styles.mobileItem}
              data-overview-channel-card={row.channel}
            >
              <h3 className={styles.mobileChannel}>
                <ChannelIdentity channel={row.channel} logo={logo} />
              </h3>
              <dl className={styles.mobileMetrics}>
                <div>
                  <dt>Spend</dt>
                  <dd>{values.spend}</dd>
                </div>
                <div>
                  <dt>Revenue</dt>
                  <dd className={styles.emphasis}>{values.revenue}</dd>
                </div>
                <div>
                  <dt>ROAS</dt>
                  <dd>
                    <RoasBadge value={row.roas} label={values.roas} />
                  </dd>
                </div>
                <div>
                  <dt>CPA</dt>
                  <dd>{values.cpa}</dd>
                </div>
                <div>
                  <dt>AOV</dt>
                  <dd>{values.aov}</dd>
                </div>
                <div>
                  <dt>Conv.</dt>
                  <dd>{values.conversions}</dd>
                </div>
                <div className={styles.mobileShare}>
                  <dt>Share</dt>
                  <dd>
                    <ShareValue label={values.share.label} width={values.share.width} />
                  </dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

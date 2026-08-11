/**
 * Zero-base product copy, EN and TR.
 *
 * Why a dedicated catalogue rather than adding to `lib/i18n.ts`: that dictionary
 * belongs to the legacy console and its shape (navigation/common groups) does
 * not describe these surfaces. The rules it establishes are honoured here —
 * `AppLanguage` is the same type, English is the same explicit fallback, and
 * `NON_TRANSLATABLE_TERMS` are preserved verbatim in both languages.
 *
 * The glossary rule matters and is enforced by test rather than by convention.
 * `ROAS`, `CTR`, `CPA`, `Meta`, `Google Ads`, `GA4`, `Shopify`, `Klaviyo` and
 * the rest are provider and metric identifiers. An operator reading a Turkish
 * surface still types "ROAS" into a spreadsheet and still sees "Meta" in the
 * provider's own UI; translating them would break the join between what this
 * product says and what every other system says.
 *
 * Turkish is longer than English for the same idea — roughly a fifth to a third
 * more characters. That is what the real-length test exists to catch: a label
 * that fits at 320 px in English and clips in Turkish is a defect in the layout,
 * not in the translation.
 */
import { NON_TRANSLATABLE_TERMS, type AppLanguage } from "@/lib/i18n";

export const ZERO_BASE_COPY = {
  en: {
    /* ------------------------------------------------------------- states */
    loading: "Loading…",
    notServed: "Not served",
    notReported: "Not reported",
    unavailable: "Unavailable",
    retry: "Retry",
    cancel: "Cancel",
    save: "Save",
    close: "Close",
    undo: "Undo",

    /* -------------------------------------------------------- collections */
    noRows: "No rows were served for this period.",
    capDisclosureUnknownTotal: "The backend did not supply a total.",

    /* --------------------------------------------------------- provenance */
    connected: "Connected",
    notConnected: "Not connected",
    connectionUnknown: "The integration status could not be read, so this connection is unknown.",

    /* -------------------------------------------------------------- verbs */
    connect: "Connect",
    reconnect: "Reconnect",
    exportCsv: "Export CSV",

    /* ------------------------------------------------------------ refusal */
    needsCollaborator:
      "Connecting or reconnecting a provider needs the collaborator role.",
    needsAdmin: "This needs the admin role.",

    /* ------------------------------------------------------------ reports */
    reportsTitle: "Reports",
    newReport: "New report",
    reportName: "Report name",
    noReports: "No reports have been created for this business yet.",

    /* --------------------------------------------------------------- team */
    teamTitle: "Team",
    members: "Members",
    invitations: "Invitations",
    accessRequests: "Access requests",

    /* ----------------------------------------------------------- workflow */
    workingOnIt: "Working…",
    confirmedByFreshRead: "Saved and confirmed by a fresh read.",
    reReadFailed:
      "The change was accepted but the confirming read failed, so the current state is unknown.",
    reReadDisagreed:
      "The change was accepted but the re-read does not show it. Treat it as unresolved.",
  },

  tr: {
    loading: "Yükleniyor…",
    notServed: "Sunulmadı",
    notReported: "Bildirilmedi",
    unavailable: "Kullanılamıyor",
    retry: "Yeniden dene",
    cancel: "Vazgeç",
    save: "Kaydet",
    close: "Kapat",
    undo: "Geri al",

    noRows: "Bu dönem için satır sunulmadı.",
    capDisclosureUnknownTotal: "Arka uç bir toplam sunmadı.",

    connected: "Bağlı",
    notConnected: "Bağlı değil",
    connectionUnknown:
      "Entegrasyon durumu okunamadı, bu nedenle bu bağlantının durumu bilinmiyor.",

    connect: "Bağlan",
    reconnect: "Yeniden bağlan",
    exportCsv: "CSV dışa aktar",

    needsCollaborator:
      "Bir sağlayıcıyı bağlamak veya yeniden bağlamak için collaborator rolü gerekir.",
    needsAdmin: "Bunun için admin rolü gerekir.",

    reportsTitle: "Raporlar",
    newReport: "Yeni rapor",
    reportName: "Rapor adı",
    noReports: "Bu işletme için henüz rapor oluşturulmadı.",

    teamTitle: "Ekip",
    members: "Üyeler",
    invitations: "Davetler",
    accessRequests: "Erişim talepleri",

    workingOnIt: "Çalışıyor…",
    confirmedByFreshRead: "Kaydedildi ve yeni bir okumayla doğrulandı.",
    reReadFailed:
      "Değişiklik kabul edildi ancak doğrulayıcı okuma tamamlanmadı, bu nedenle güncel durum bilinmiyor.",
    reReadDisagreed:
      "Değişiklik kabul edildi ancak yeniden okuma bunu göstermiyor. Çözülmemiş olarak değerlendirin.",
  },
} as const;

export type ZeroBaseCopyKey = keyof (typeof ZERO_BASE_COPY)["en"];
export type ZeroBaseCopy = (typeof ZERO_BASE_COPY)["en"];

/**
 * Copy for a language, falling back to English explicitly.
 *
 * The fallback is a value, not an accident: a language with no catalogue must
 * render English rather than blank keys, and the parity test makes sure that
 * path is never reached for a language the UI actually offers.
 */
export function zeroBaseCopy(language: AppLanguage | null | undefined): ZeroBaseCopy {
  return language === "tr" ? (ZERO_BASE_COPY.tr as unknown as ZeroBaseCopy) : ZERO_BASE_COPY.en;
}

/** The terms that must survive translation byte-for-byte. */
export { NON_TRANSLATABLE_TERMS };

/**
 * Does this string keep every non-translatable term the English original used?
 *
 * Used by the glossary test. A Turkish string that renders "ROAS" as "YG" has
 * silently broken the join with every other system the operator reads.
 */
export function preservesGlossary(english: string, translated: string): string[] {
  const missing: string[] = [];
  for (const term of NON_TRANSLATABLE_TERMS) {
    const inEnglish = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(english);
    if (!inEnglish) continue;
    const inTranslated = translated.includes(term);
    if (!inTranslated) missing.push(term);
  }
  return missing;
}

import "@/app/marketing-ledger.css";

import { MarketingNavbar } from "@/components/marketing/MarketingNavbar";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    // Ledger presentation is scoped to this attribute. No workspace shell,
    // no product-only tokens, and no session is required to render it.
    <div data-adc-marketing className="flex min-h-screen flex-col">
      <MarketingNavbar />
      <main id="main-content" className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}

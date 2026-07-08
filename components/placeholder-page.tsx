import { type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProductPageShell, ProductSection } from "@/components/ui/product-surface";
import { usePreferencesStore } from "@/store/preferences-store";

interface PlaceholderPageProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  badge?: string;
}

export function PlaceholderPage({
  title,
  description,
  icon: Icon,
  badge,
}: PlaceholderPageProps) {
  const language = usePreferencesStore((state) => state.language);
  return (
    <ProductPageShell
      eyebrow={badge}
      title={title}
      description={
        description ??
        (language === "tr"
          ? "Bu sayfa hazırlanıyor. Yakında tekrar kontrol edin."
          : "This page is under construction. Check back soon.")
      }
      className="max-w-3xl"
      actions={
        Icon ? (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-white">
            <Icon className="h-5 w-5 text-neutral-500" />
          </div>
        ) : null
      }
    >
      <ProductSection>
        <div className="flex items-center gap-2">
          {badge ? (
            <Badge variant="secondary" className="rounded-md border border-neutral-200 bg-neutral-100 text-[10px] uppercase tracking-[0.12em] text-neutral-600">
              {badge}
            </Badge>
          ) : null}
          <span className="text-sm text-neutral-500">
            {language === "tr" ? "Durum: planlandı" : "Status: planned"}
          </span>
        </div>
      </ProductSection>
    </ProductPageShell>
  );
}

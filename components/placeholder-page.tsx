import { type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
    <div className="grid min-h-[60vh] place-items-center px-4 py-8 text-center">
      <div className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-6">
        {Icon && (
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50">
            <Icon className="h-5 w-5 text-neutral-500" />
          </div>
        )}
        <div className="flex items-center justify-center gap-2">
          <h2 className="text-[18px] font-semibold tracking-tight text-neutral-950">{title}</h2>
          {badge && (
            <Badge variant="secondary" className="rounded-md border border-neutral-200 bg-neutral-100 text-[10px] uppercase tracking-[0.12em] text-neutral-600">
              {badge}
            </Badge>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-neutral-500">
          {description ?? (language === "tr" ? "Bu sayfa hazırlanıyor. Yakında tekrar kontrol edin." : "This page is under construction. Check back soon.")}
        </p>
      </div>
    </div>
  );
}

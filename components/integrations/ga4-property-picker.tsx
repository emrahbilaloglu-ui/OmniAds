"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { DataEmptyState } from "@/components/states/DataEmptyState";
import {
  fetchGa4Properties,
  saveGa4PropertySelection,
  type GA4Property,
} from "@/components/integrations/ga4-property-picker-support";
import { Loader2, Search } from "lucide-react";

type FetchState = "idle" | "loading" | "success" | "empty" | "error";

interface GA4PropertyPickerProps {
  open: boolean;
  businessId: string;
  currentPropertyId?: string | null;
  onClose: () => void;
  onSave: (property: GA4Property) => void;
}

export function GA4PropertyPicker({
  open,
  businessId,
  currentPropertyId,
  onClose,
  onSave,
}: GA4PropertyPickerProps) {
  const [properties, setProperties] = useState<GA4Property[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const loadProperties = useMemo(
    () => async () => {
      if (!open) return;

      setProperties([]);
      setFetchState("loading");
      setErrorMessage(null);
      setSaveError(null);

      const result = await fetchGa4Properties(businessId);
      if (result.error) {
        setErrorMessage(result.error);
        setFetchState("error");
        return;
      }

      setProperties(result.properties);
      setSelectedId(result.selectedPropertyId ?? currentPropertyId ?? null);
      setFetchState(result.properties.length > 0 ? "success" : "empty");
    },
    [open, businessId, currentPropertyId],
  );

  useEffect(() => {
    if (!open) return;
    loadProperties();
  }, [open, loadProperties]);

  useEffect(() => {
    if (!open) {
      setProperties([]);
      setFetchState("idle");
      setErrorMessage(null);
      setSaveError(null);
      setSelectedId(null);
      setSearch("");
      setIsSaving(false);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return properties;
    const q = search.toLowerCase();
    return properties.filter(
      (p) =>
        p.propertyName.toLowerCase().includes(q) ||
        p.accountName.toLowerCase().includes(q) ||
        p.propertyId.toLowerCase().includes(q),
    );
  }, [properties, search]);

  async function handleSave() {
    const selected = properties.find((p) => p.propertyId === selectedId);
    if (!selected) return;

    setIsSaving(true);
    setSaveError(null);

    const result = await saveGa4PropertySelection({ businessId, property: selected });
    if (result.error) {
      setSaveError(result.error);
    } else {
      onSave(selected);
      onClose();
    }
    setIsSaving(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? onClose() : undefined)}
    >
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col p-0 sm:max-w-xl"
      >
        <div className="shrink-0 border-b px-6 py-6">
          <SheetHeader className="space-y-2">
            <SheetTitle>Select GA4 Property</SheetTitle>
            <SheetDescription>
              Choose the Google Analytics 4 property to link with this business.
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {fetchState === "loading" && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading GA4 properties...
            </div>
          )}

          {fetchState === "error" && (
            <DataEmptyState
              title="Could not load properties"
              description={
                errorMessage ?? "We couldn't fetch accessible GA4 properties."
              }
            />
          )}

          {fetchState === "empty" && (
            <DataEmptyState
              title="No GA4 properties found"
              description="This Google account does not have access to any GA4 properties. Make sure you have at least Viewer access to a GA4 property."
            />
          )}

          {fetchState === "success" && (
            <div className="space-y-3">
              {properties.length > 5 && (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Search properties..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full rounded-md border border-neutral-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              {filtered.map((p) => {
                const isSelected = selectedId === p.propertyId;
                return (
                  <label
                    key={p.propertyId}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="ga4-property"
                      checked={isSelected}
                      onChange={() => setSelectedId(p.propertyId)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{p.propertyName}</p>
                      <p className="text-xs text-muted-foreground">
                        Account: {p.accountName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.propertyId}
                      </p>
                    </div>
                  </label>
                );
              })}

              {filtered.length === 0 && search.trim() && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No properties match &ldquo;{search}&rdquo;
                </p>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t px-6 py-4">
          {saveError && (
            <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!selectedId || isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Link Property"
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

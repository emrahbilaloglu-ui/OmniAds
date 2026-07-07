"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

export function BusinessEmptyState() {
  const router = useRouter();

  return (
    <div className="grid min-h-[60vh] place-items-center px-4 py-8">
      <div className="w-full max-w-xl rounded-xl border border-neutral-200 bg-white p-6 text-center">
        <h2 className="text-[18px] font-semibold tracking-tight text-neutral-950">Create your first business</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-neutral-500">
          Set up a business to connect ad accounts, stores, and analytics properties.
        </p>
        <Button className="mt-5 rounded-md" onClick={() => router.push("/businesses/new")}>
          Create business
        </Button>
      </div>
    </div>
  );
}

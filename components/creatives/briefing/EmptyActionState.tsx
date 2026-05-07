"use client";

import { ArrowRight, CheckCircle2, Clock, Eye, ShieldCheck } from "lucide-react";

export const EMPTY_ACTION_LAUNCH_HREF = "/platforms/meta/launchpad?fromBriefing=true&mode=fresh_test";

interface EmptyActionStateProps {
  matureCount: number;
  watchingCount: number;
  onLaunchNewTest: () => void;
}

export function EmptyActionState({
  matureCount,
  watchingCount,
  onLaunchNewTest,
}: EmptyActionStateProps) {
  return (
    <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]" data-empty-action-state>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center shrink-0">
          <CheckCircle2 className="inline-block shrink-0" size={20} aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-slate-900">
            Nothing for you to do right now.
          </div>
          <div className="text-[12.5px] text-slate-600 mt-1">
            {matureCount} mature creatives · {watchingCount} watching · Next engine pass: ~2h
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-emerald-200 bg-white text-emerald-700 text-[11.5px] font-medium">
              <ShieldCheck className="inline-block shrink-0" size={12} aria-hidden="true" />
              Triage clear
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 text-[11.5px]">
              <Eye className="inline-block shrink-0" size={12} aria-hidden="true" />
              Watching lane stays visible
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 text-[11.5px]">
              <Clock className="inline-block shrink-0" size={12} aria-hidden="true" />
              Next engine pass: ~2h
            </span>
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12px] font-medium"
              data-empty-action="launch-new-test"
              onClick={onLaunchNewTest}
            >
              Launch a new test
              <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

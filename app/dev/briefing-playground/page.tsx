import { notFound } from "next/navigation";
import BriefingPlaygroundPage from "@/components/common/briefing/__playground__/page";

export default function DevBriefingPlaygroundRoute() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return <BriefingPlaygroundPage />;
}

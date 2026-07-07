import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = "Something went wrong",
  description = "The request failed. Please try again.",
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-5">
      <h3 className="text-base font-semibold text-rose-900">{title}</h3>
      <p className="mt-2 text-sm leading-5 text-rose-700">{description}</p>
      {onRetry && (
        <Button className="mt-4 rounded-md border-rose-200 bg-white text-rose-900 hover:bg-rose-50" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

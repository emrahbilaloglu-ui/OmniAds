import { Skeleton } from "@/components/ui/skeleton";

interface LoadingSkeletonProps {
  rows?: number;
  title?: string;
  description?: string;
}

export function LoadingSkeleton({
  rows = 5,
  title,
  description,
}: LoadingSkeletonProps) {
  return (
    <div className="space-y-3" data-testid="loading-skeleton">
      {(title || description) && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          {title && <p className="text-sm font-medium">{title}</p>}
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-xl border border-neutral-200 bg-white p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-3 h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

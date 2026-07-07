interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center">
      <h3 className="text-base font-semibold tracking-tight text-neutral-950">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-neutral-500">{description}</p>
    </div>
  );
}

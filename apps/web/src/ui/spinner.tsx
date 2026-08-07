import type { ReactElement } from "react";

import { cn } from "../lib/cn.js";

export function Spinner({ className }: { className?: string | undefined }): ReactElement {
  return (
    <span
      role="presentation"
      className={cn(
        "size-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary",
        className,
      )}
    />
  );
}

export function Loading({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

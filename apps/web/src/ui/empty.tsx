import type { ReactElement } from "react";

export function Empty({ title, hint }: { title: string; hint?: string | undefined }): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <h3 className="text-sm font-medium">{title}</h3>
      {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

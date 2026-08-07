import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export function Textarea({ className, ...props }: ComponentProps<"textarea">): ReactElement {
  return (
    <textarea
      className={cn(
        "flex min-h-20 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm",
        "transition-colors duration-150 placeholder:text-muted-foreground/70",
        "hover:border-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

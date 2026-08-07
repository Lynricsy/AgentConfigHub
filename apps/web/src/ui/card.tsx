import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export function Card({ className, ...props }: ComponentProps<"section">): ReactElement {
  return (
    <section
      className={cn("rounded-lg border border-border bg-card text-card-foreground shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"header">): ReactElement {
  return <header className={cn("flex flex-col gap-1 border-b border-border px-4 py-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">): ReactElement {
  return <h2 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">): ReactElement {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"footer">): ReactElement {
  return (
    <footer
      className={cn("flex flex-wrap items-center gap-2 border-t border-border px-4 py-3", className)}
      {...props}
    />
  );
}

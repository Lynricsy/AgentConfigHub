import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export const inputClassName = [
  "flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-sm",
  "transition-colors duration-150 placeholder:text-muted-foreground/70",
  "hover:border-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
  "file:mr-3 file:rounded-sm file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-xs file:font-medium",
].join(" ");

export function Input({ className, ...props }: ComponentProps<"input">): ReactElement {
  return <input className={cn(inputClassName, className)} {...props} />;
}

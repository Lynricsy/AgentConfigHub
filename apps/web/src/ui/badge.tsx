import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
    "text-[0.6875rem] font-medium leading-4 whitespace-nowrap",
    "[&_svg]:size-3 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "border-primary/35 bg-primary/12 text-primary",
        success: "border-success/35 bg-success/12 text-success",
        warning: "border-warning/35 bg-warning/12 text-warning",
        destructive: "border-destructive/35 bg-destructive/12 text-destructive",
        outline: "border-border bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps): ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

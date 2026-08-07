import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
    "font-medium transition-colors duration-150",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        // 暗色下 destructive 亮度高，白字对比度仅 3.4:1，故改用深色前景
        destructive: "bg-destructive text-white hover:bg-destructive/85 dark:text-background",
        outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        sm: "h-7 px-2 text-xs [&_svg]:size-3.5",
        default: "h-9 px-3.5 text-sm [&_svg]:size-4",
        lg: "h-10 px-5 text-sm [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps): ReactElement {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

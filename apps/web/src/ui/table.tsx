import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export function Table({ className, ...props }: ComponentProps<"table">): ReactElement {
  return <table className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">): ReactElement {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">): ReactElement {
  return <tbody className={cn("[&_tr:not(:last-child)]:border-b [&_tr]:border-border", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">): ReactElement {
  return <tr className={cn("transition-colors duration-150 hover:bg-accent/45", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">): ReactElement {
  return (
    <th
      className={cn(
        "px-3 py-2 text-left align-middle text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">): ReactElement {
  return <td className={cn("px-3 py-2 align-middle", className)} {...props} />;
}

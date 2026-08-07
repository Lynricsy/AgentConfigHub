import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "../lib/cn.js";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>): ReactElement {
  return (
    <TabsPrimitive.List
      className={cn("inline-flex h-8 items-center gap-0.5 rounded-md border border-border bg-secondary p-0.5", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>): ReactElement {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium",
        "text-muted-foreground transition-colors duration-150 hover:text-foreground",
        "data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>): ReactElement {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...props} />;
}

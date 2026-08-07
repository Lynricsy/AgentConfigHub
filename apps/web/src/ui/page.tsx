import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/cn.js";

export function Page({
  title,
  lede,
  actions,
  fill = false,
  children,
}: {
  title: string;
  lede?: string | undefined;
  actions?: ReactNode | undefined;
  /** 锁高页面（编辑器类）：整页填满 <main>，由内部容器自行滚动，不产生第二个滚动条。 */
  fill?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-6",
        fill && "h-full min-h-0",
      )}
    >
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {lede && <p className="max-w-2xl text-sm text-muted-foreground">{lede}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("flex flex-col gap-5", fill && "min-h-0 flex-1")}>{children}</div>
    </div>
  );
}

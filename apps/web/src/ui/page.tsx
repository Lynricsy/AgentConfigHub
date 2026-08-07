import type { ReactElement, ReactNode } from "react";

export function Page({
  title,
  lede,
  actions,
  children,
}: {
  title: string;
  lede?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {lede && <p className="max-w-2xl text-sm text-muted-foreground">{lede}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

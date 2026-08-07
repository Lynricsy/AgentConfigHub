import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/cn.js";

const labelText = "text-xs font-medium text-muted-foreground";

/**
 * 表单字段包装。
 *
 * - 不传 `htmlFor`：渲染包裹式 `<label>`，原生控件由包裹关系获得可访问名。
 * - 传 `htmlFor`：渲染独立 `<label for>`，用于 Radix Select 等自定义控件
 *   （此时调用方还需在 Trigger 上同时给 `id` 与 `aria-label`）。
 */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string | undefined;
  hint?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}): ReactElement {
  if (htmlFor === undefined) {
    return (
      <label className={cn("flex flex-col gap-1.5", className)}>
        <span className={labelText}>{label}</span>
        {children}
        {hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
      </label>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label className={labelText} htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
    </div>
  );
}

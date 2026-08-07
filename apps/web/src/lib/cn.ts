import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind class：先由 clsx 归一化条件表达式，再由 tailwind-merge 消解冲突工具类。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

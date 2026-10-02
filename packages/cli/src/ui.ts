import { homedir } from "node:os";
import { sep } from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";

// 终端展示层：输出流是 TTY 时渲染彩色表格、面板与加载动画；
// 否则输出不带装饰的纯文本（表格为无表头 TSV），保持脚本可解析。

type Stream = NodeJS.WriteStream;
type Tone = keyof typeof TONES;
export type Style = Tone | "bold" | "underline" | readonly (Tone | "bold" | "underline")[];

export const symbols = {
  success: "✔",
  failure: "✖",
  warning: "⚠",
  info: "ℹ",
  brand: "◆",
} as const;

// 语义配色：真彩色终端用浅色调，在黑底与半透明灰底上都清晰；不足 24 位色时退回 ANSI 高亮色。
// 刻意不用 dim：在半透明或浅色背景的终端里 dim 文本几乎不可见。
const TONES = {
  heading: { rgb: [0xff, 0xa3, 0xe6], fallback: "magentaBright" },
  accent: { rgb: [0x7f, 0xe3, 0xff], fallback: "cyanBright" },
  number: { rgb: [0xff, 0xe2, 0x7a], fallback: "yellowBright" },
  path: { rgb: [0xb4, 0xcc, 0xff], fallback: "blueBright" },
  sensitive: { rgb: [0xff, 0xa8, 0xd8], fallback: "magentaBright" },
  success: { rgb: [0x9c, 0xff, 0xa0], fallback: "greenBright" },
  warning: { rgb: [0xff, 0xc2, 0x7a], fallback: "yellowBright" },
  danger: { rgb: [0xff, 0x9a, 0x9a], fallback: "redBright" },
  unchanged: { rgb: [0xc9, 0xbf, 0xff], fallback: "blueBright" },
} as const;

const INDENT = "  ";

export function isRich(stream: Stream = process.stdout): boolean {
  return stream.isTTY === true;
}

// getColorDepth 已遵循 NO_COLOR / FORCE_COLOR / TERM=dumb；非 TTY 交给 styleText 判断 FORCE_COLOR。
export function paint(style: Style, text: string, stream: Stream = process.stdout): string {
  const parts = typeof style === "string" ? [style] : style;
  if (stream.isTTY && stream.getColorDepth() >= 24) {
    const open: string[] = [];
    const close: string[] = [];
    for (const part of parts) {
      if (part === "bold") { open.push("1"); close.push("22"); }
      else if (part === "underline") { open.push("4"); close.push("24"); }
      else { open.push(`38;2;${TONES[part].rgb.join(";")}`); close.push("39"); }
    }
    return `\x1b[${open.join(";")}m${text}\x1b[${close.join(";")}m`;
  }
  return styleText(parts.map((part) => part === "bold" || part === "underline" ? part : TONES[part].fallback), text, { stream });
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

// 终端列宽：CJK/全角字符占两列，控制符、组合符与变体选择符不占列。
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) {
    const codePoint = char.codePointAt(0)!;
    if (
      codePoint < 0x20
      || (codePoint >= 0x7f && codePoint < 0xa0)
      || (codePoint >= 0x300 && codePoint <= 0x36f)
      || codePoint === 0x200d
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    ) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

// 富文本模式下把家目录缩写为 ~，纯文本模式保留绝对路径。
export function displayPath(path: string): string {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 表格单元：text 用于富文本展示，plain 覆盖纯文本输出，style 仅在富文本模式生效。 */
export type Cell = string | { readonly text: string; readonly plain?: string; readonly style?: Style };

function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

function cellStyled(cell: Cell): string {
  return typeof cell === "string" || !cell.style || cell.text === "" ? cellText(cell) : paint(cell.style, cell.text);
}

export interface TableOptions {
  readonly header?: readonly string[];
  readonly indent?: number;
}

export function printTable(rows: readonly (readonly Cell[])[], options: TableOptions = {}): void {
  const out = process.stdout;
  if (!isRich(out)) {
    for (const row of rows) out.write(`${row.map((cell) => typeof cell === "string" ? cell : cell.plain ?? cell.text).join("\t")}\n`);
    return;
  }
  const header: Cell[] | undefined = options.header?.map((text) => ({ text, style: ["bold", "underline", "heading"] }));
  const all = header ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 0, displayWidth(cellText(cell))); });
  }
  const indent = " ".repeat(options.indent ?? INDENT.length);
  for (const row of all) {
    const cells = row.map((cell, index) =>
      index === row.length - 1 ? cellStyled(cell) : cellStyled(cell) + " ".repeat(widths[index]! - displayWidth(cellText(cell))));
    out.write(`${indent}${cells.join("  ").trimEnd()}\n`);
  }
}

/** 键值面板：富文本模式绘制圆角边框，纯文本模式输出 `键: 值` 行。 */
export function printPanel(title: string, pairs: readonly (readonly [key: string, value: string, style?: Style])[]): void {
  const out = process.stdout;
  if (!isRich(out)) {
    for (const [key, value] of pairs) out.write(`${key}: ${value}\n`);
    return;
  }
  const keyWidth = Math.max(...pairs.map(([key]) => displayWidth(key)));
  const lines = pairs.map(([key, value, style]) => ({
    width: keyWidth + 3 + displayWidth(value),
    text: `${paint(["bold", "heading"], key + " ".repeat(keyWidth - displayWidth(key)))}   ${style ? paint(style, value) : value}`,
  }));
  const titleWidth = displayWidth(title);
  // 内宽 = 最长内容 + 左右各 2 列留白；标题栏同样不能溢出。
  const inner = Math.max(titleWidth + 4, ...lines.map(({ width }) => width)) + 4;
  const border = (text: string) => paint("accent", text);
  const empty = `${INDENT}${border("│")}${" ".repeat(inner)}${border("│")}\n`;
  out.write(`\n${INDENT}${border("╭─")} ${paint(["bold", "number"], title)} ${border(`${"─".repeat(inner - titleWidth - 3)}╮`)}\n`);
  out.write(empty);
  for (const line of lines) out.write(`${INDENT}${border("│")}  ${line.text}${" ".repeat(inner - 2 - line.width)}${border("│")}\n`);
  out.write(empty);
  out.write(`${INDENT}${border(`╰${"─".repeat(inner)}╯`)}\n\n`);
}

/** 区块标题，仅富文本模式输出。 */
export function printHeading(title: string, detail?: string): void {
  if (!isRich()) return;
  process.stdout.write(`\n${INDENT}${paint(["bold", "heading"], title)}${detail ? `  ${paint("number", detail)}` : ""}\n\n`);
}

/** 富文本模式输出子标题行（已带缩进），纯文本模式不输出。 */
export function printRichLine(text: string): void {
  if (isRich()) process.stdout.write(`${INDENT}${text}\n`);
}

function message(stream: Stream, style: Style, symbol: string, text: string): void {
  stream.write(isRich(stream) ? `${INDENT}${paint(style, symbol, stream)} ${text}\n` : `${text}\n`);
}

export const success = (text: string) => message(process.stdout, "success", symbols.success, text);
export const info = (text: string) => message(process.stdout, "accent", symbols.info, text);
export const warning = (text: string) => message(process.stdout, "warning", symbols.warning, text);
export const failure = (text: string) => message(process.stderr, "danger", symbols.failure, text);

export interface Spinner {
  stop(): void;
}

// 加载动画写入 stderr，避免污染 stdout；非 TTY 时为空操作。
export function startSpinner(text: string | (() => string)): Spinner {
  const stream = process.stderr;
  if (!isRich(stream)) return { stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const render = () => {
    const label = typeof text === "string" ? text : text();
    stream.write(`\r\x1b[2K${INDENT}${paint("accent", frames[frame++ % frames.length]!, stream)} ${label}`);
  };
  render();
  const timer = setInterval(render, 80);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      stream.write("\r\x1b[2K");
    },
  };
}

export async function withSpinner<T>(text: string, task: () => Promise<T>): Promise<T> {
  const spinner = startSpinner(text);
  try {
    return await task();
  } finally {
    spinner.stop();
  }
}

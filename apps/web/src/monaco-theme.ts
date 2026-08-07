import type { Monaco } from "@monaco-editor/react";

import type { ResolvedTheme } from "./theme.js";

/**
 * Monaco 不解析 CSS 变量,因此两套主题的色值必须写死。
 * 这些 hex 是 index.css 中语义 token 的 sRGB 等价值,改动 token 时需同步。
 */
const dark = {
  base: "vs-dark",
  colors: {
    "editor.background": "#14181c",       // --card
    "editor.foreground": "#f1f4f6",       // --foreground
    "editorLineNumber.foreground": "#5a636c",
    "editorLineNumber.activeForeground": "#dcf55f", // --primary
    "editor.lineHighlightBackground": "#1a1f24",
    "editorCursor.foreground": "#dcf55f",
    "editor.selectionBackground": "#2f3a1e",
    "editorIndentGuide.background1": "#242a30",
    "editorIndentGuide.activeBackground1": "#3a424a",
    "editorWidget.background": "#1a1f24",
    "editorWidget.border": "#292e34",     // --border
    "editorGutter.background": "#14181c",
    "editorError.foreground": "#f05653",  // --destructive
    "editorWarning.foreground": "#f5b845", // --warning
  },
  rules: [
    { token: "comment", foreground: "6f7a84" },
    { token: "string", foreground: "c8e88a" },
    { token: "number", foreground: "f5b845" },
    { token: "keyword", foreground: "49d3a7" },
    { token: "type", foreground: "49d3a7" },
    { token: "key", foreground: "f1f4f6" },
  ],
} as const;

const light = {
  base: "vs",
  colors: {
    "editor.background": "#ffffff",       // --card
    "editor.foreground": "#14191e",       // --foreground
    "editorLineNumber.foreground": "#8c949c",
    "editorLineNumber.activeForeground": "#4e7913", // --primary
    "editor.lineHighlightBackground": "#f4f6f8",
    "editorCursor.foreground": "#4e7913",
    "editor.selectionBackground": "#dcecc0",
    "editorIndentGuide.background1": "#e6e9ec",
    "editorIndentGuide.activeBackground1": "#c8cdd2",
    "editorWidget.background": "#f7f9fa",
    "editorWidget.border": "#dce0e3",     // --border
    "editorGutter.background": "#ffffff",
    "editorError.foreground": "#c31b1f",  // --destructive
    "editorWarning.foreground": "#a16600", // --warning
  },
  rules: [
    { token: "comment", foreground: "6b7a86" },
    { token: "string", foreground: "3f6410" },
    { token: "number", foreground: "8a5300" },
    { token: "keyword", foreground: "00614a" },
    { token: "type", foreground: "00614a" },
    { token: "key", foreground: "14191e" },
  ],
} as const;

export function defineMonacoThemes(monaco: Monaco): void {
  for (const [name, theme] of [["agch-dark", dark], ["agch-light", light]] as const) {
    monaco.editor.defineTheme(name, {
      base: theme.base,
      inherit: true,
      rules: [...theme.rules],
      colors: { ...theme.colors },
    });
  }
}

export function monacoThemeFor(resolved: ResolvedTheme): string {
  return resolved === "dark" ? "agch-dark" : "agch-light";
}

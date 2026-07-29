/// <reference lib="webworker" />

import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

interface SyntaxRequest {
  id: number;
  language: string;
  text: string;
}

interface SyntaxDiagnostic {
  message: string;
  line: number;
  column: number;
}

function markdownDiagnostics(text: string): SyntaxDiagnostic[] {
  const fences = text.split("\n").reduce((count, line) => count + (line.trimStart().startsWith("```") ? 1 : 0), 0);
  return fences % 2 === 0 ? [] : [{ message: "Markdown code fence is not terminated.", line: 1, column: 1 }];
}

self.onmessage = (event: MessageEvent<SyntaxRequest>) => {
  const { id, language, text } = event.data;
  const diagnostics: SyntaxDiagnostic[] = [];
  try {
    if (language === "yaml") {
      const document = parseDocument(text);
      for (const error of document.errors) diagnostics.push({ message: error.message, line: 1, column: 1 });
    } else if (language === "toml") {
      parseToml(text);
    } else if (language === "markdown") {
      diagnostics.push(...markdownDiagnostics(text));
    }
  } catch (error) {
    diagnostics.push({
      message: error instanceof Error ? error.message : "Syntax is invalid.",
      line: 1,
      column: 1,
    });
  }
  self.postMessage({ id, diagnostics });
};

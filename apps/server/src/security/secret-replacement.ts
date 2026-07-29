import { visit as visitJson } from "jsonc-parser";
import { isScalar, parseDocument, visit as visitYaml } from "yaml";

import type { Diagnostic } from "@agent-config-hub/protocol";

import { lintToml } from "./taplo-lint.js";

export type SecretFormat = "json" | "jsonc" | "toml" | "yaml" | "dotenv";

export interface SecretReplacementResult {
  readonly text: string;
  readonly slots: readonly string[];
  readonly sensitive: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

interface Replacement {
  start: number;
  end: number;
  value: string;
  slot: string;
}

const placeholderPattern = /^\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}$/;
const placeholderAnywhere = /\{\{secret:[^}]*\}\}/g;
const inlineSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bxai-[A-Za-z0-9_-]{20,}\b/g,
];

function rangeAt(text: string, offset: number, length: number): NonNullable<Diagnostic["range"]> {
  const before = text.slice(0, offset);
  const startLine = before.split("\n").length;
  const startColumn = offset - before.lastIndexOf("\n");
  const selected = text.slice(offset, offset + length);
  const lines = selected.split("\n");
  return {
    startLine,
    startColumn,
    endLine: startLine + lines.length - 1,
    endColumn: lines.length === 1 ? startColumn + length : (lines.at(-1)?.length ?? 0) + 1,
  };
}

function escapedSecret(value: string): string {
  return JSON.stringify(value);
}

function scanTomlStrings(text: string): { start: number; end: number; value: string; valuePosition: boolean }[] {
  const tokens: { start: number; end: number; value: string; valuePosition: boolean }[] = [];
  const contexts: { kind: "array" | "inline"; valuePosition: boolean }[] = [];
  let offset = 0;
  let rootValuePosition = false;
  while (offset < text.length) {
    const character = text[offset]!;
    if (character === "\n") {
      if (contexts.length === 0) rootValuePosition = false;
      offset += 1;
      continue;
    }
    if (character === "#") {
      const newline = text.indexOf("\n", offset);
      offset = newline === -1 ? text.length : newline;
      continue;
    }
    const inlineContext = contexts.findLast(({ kind }) => kind === "inline");
    const currentlyInValue = inlineContext?.valuePosition ?? rootValuePosition;
    if (character === "=") {
      if (inlineContext) inlineContext.valuePosition = true;
      else rootValuePosition = true;
      offset += 1;
      continue;
    }
    if (character === "{") {
      contexts.push({ kind: "inline", valuePosition: false });
      offset += 1;
      continue;
    }
    if (character === "[") {
      if (currentlyInValue) contexts.push({ kind: "array", valuePosition: true });
      offset += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "inline" : "array";
      if (contexts.at(-1)?.kind === expected) contexts.pop();
      offset += 1;
      continue;
    }
    if (character === "," && contexts.at(-1)?.kind === "inline") {
      contexts.at(-1)!.valuePosition = false;
      offset += 1;
      continue;
    }
    if (character !== '"' && character !== "'") {
      offset += 1;
      continue;
    }
    const quote = character;
    const start = offset;
    offset += 1;
    let value = "";
    while (offset < text.length && text[offset] !== quote) {
      if (quote === '"' && text[offset] === "\\" && offset + 1 < text.length) {
        const escaped = text.slice(offset, offset + 2);
        value += JSON.parse(`"${escaped}"`) as string;
        offset += 2;
      } else {
        value += text[offset]!;
        offset += 1;
      }
    }
    if (offset < text.length) offset += 1;
    tokens.push({ start, end: offset, value, valuePosition: currentlyInValue });
  }
  return tokens;
}

export async function replaceSecretScalars(
  text: string,
  format: SecretFormat,
  resolve: (slot: string) => string | undefined,
): Promise<SecretReplacementResult> {
  const diagnostics: Diagnostic[] = [];
  const candidates: { start: number; end: number; value: string }[] = [];

  if (format === "json" || format === "jsonc") {
    const errors: { error: number; offset: number; length: number }[] = [];
    visitJson(text, {
      onError(error, offset, length) {
        errors.push({ error, offset, length });
      },
      onLiteralValue(value, offset, length) {
        if (typeof value === "string") candidates.push({ start: offset, end: offset + length, value });
      },
    }, { allowTrailingComma: format === "jsonc", disallowComments: format === "json" });
    for (const error of errors) diagnostics.push({
      code: "FORMAT_SYNTAX_ERROR",
      severity: "error",
      message: `Invalid ${format.toUpperCase()} syntax (${error.error}).`,
      range: rangeAt(text, error.offset, error.length),
    });
  } else if (format === "yaml") {
    const document = parseDocument(text, { keepSourceTokens: true });
    for (const error of document.errors) diagnostics.push({
      code: "FORMAT_SYNTAX_ERROR",
      severity: "error",
      message: error.message,
      range: rangeAt(text, error.pos[0], Math.max(1, error.pos[1] - error.pos[0])),
    });
    visitYaml(document, {
      Scalar(_key, node) {
        if (_key !== "key" && isScalar(node) && typeof node.value === "string" && node.range) {
          candidates.push({ start: node.range[0], end: node.range[1], value: node.value });
        }
      },
    });
  } else if (format === "toml") {
    diagnostics.push(...await lintToml(text));
    for (const token of scanTomlStrings(text)) {
      if (token.valuePosition) candidates.push({ start: token.start, end: token.end, value: token.value });
    }
  } else {
    let offset = 0;
    for (const line of text.split(/(?<=\n)/)) {
      const body = line.endsWith("\n") ? line.slice(0, -1) : line;
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*(?:#.*)?$/.exec(body);
      if (match?.[1]) {
        const raw = match[1];
        const start = offset + body.indexOf(raw);
        const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
        candidates.push({ start, end: start + raw.length, value: quoted ? raw.slice(1, -1) : raw });
      }
      offset += line.length;
    }
  }

  const replacements: Replacement[] = [];
  for (const candidate of candidates) {
    const placeholder = placeholderPattern.exec(candidate.value);
    if (!placeholder?.[1]) continue;
    const value = resolve(placeholder[1]);
    if (value === undefined) {
      diagnostics.push({
        code: "SECRET_BINDING_MISSING",
        severity: "error",
        message: `Secret slot ${placeholder[1]} has no credential binding.`,
        range: rangeAt(text, candidate.start, candidate.end - candidate.start),
      });
      continue;
    }
    replacements.push({ ...candidate, value: escapedSecret(value), slot: placeholder[1] });
  }

  for (const match of text.matchAll(placeholderAnywhere)) {
    const start = match.index;
    const allowed = replacements.some((replacement) => start >= replacement.start && start < replacement.end) ||
      candidates.some((candidate) => {
        const scalar = placeholderPattern.test(candidate.value);
        return scalar && start >= candidate.start && start < candidate.end;
      });
    if (!allowed) diagnostics.push({
      code: "SECRET_PLACEHOLDER_NOT_SCALAR",
      severity: "error",
      message: "Secret placeholders must be the complete value of a supported string scalar.",
      range: rangeAt(text, start, match[0].length),
    });
  }

  for (const pattern of inlineSecretPatterns) {
    for (const match of text.matchAll(pattern)) diagnostics.push({
      code: "INLINE_SECRET_DETECTED",
      severity: "error",
      message: "A high-confidence inline secret was detected; use a credential slot instead.",
      range: rangeAt(text, match.index, match[0].length),
    });
  }

  let output = text;
  for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return {
    text: output,
    slots: [...new Set(replacements.map(({ slot }) => slot))].sort(),
    sensitive: replacements.length > 0,
    diagnostics,
  };
}

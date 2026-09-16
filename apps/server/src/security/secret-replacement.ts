import { visit as visitJson } from "jsonc-parser";
import { isPair, isScalar, parseDocument, visit as visitYaml } from "yaml";

import type { Diagnostic } from "@agent-config-hub/protocol";

import { lintToml } from "./taplo-lint.js";

export type SecretFormat = "json" | "jsonc" | "toml" | "yaml" | "dotenv";

export interface SecretReplacementResult {
  readonly text: string;
  readonly slots: readonly string[];
  readonly sensitive: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly deviceNameSlots: readonly { start: number; end: number; format: SecretFormat }[];
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

export function scanInlineSecrets(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const pattern of inlineSecretPatterns) {
    for (const match of text.matchAll(pattern)) diagnostics.push({
      code: "INLINE_SECRET_DETECTED",
      severity: "error",
      message: "A high-confidence inline secret was detected; use a credential slot instead.",
      range: rangeAt(text, match.index, match[0].length),
    });
  }
  return diagnostics;
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
    const delimiter = text.startsWith(quote.repeat(3), offset) ? quote.repeat(3) : quote;
    offset += delimiter.length;
    if (delimiter.length === 3) {
      if (text.startsWith("\r\n", offset)) offset += 2;
      else if (text[offset] === "\n") offset += 1;
    }
    let value = "";
    while (offset < text.length && !text.startsWith(delimiter, offset)) {
      if (quote === '"' && text[offset] === "\\" && offset + 1 < text.length) {
        const escaped = text.slice(offset).match(/^\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[btnfr"\\])/);
        const continuation = delimiter.length === 3 ? /^\\[ \t]*\r?\n\s*/.exec(text.slice(offset)) : null;
        if (continuation) {
          offset += continuation[0].length;
          continue;
        }
        if (escaped) {
          const token = escaped[0];
          const point = token.startsWith("\\U") ? Number.parseInt(token.slice(2), 16) : null;
          value += point === null ? JSON.parse(`"${token}"`) as string
            : point <= 0x10ffff ? String.fromCodePoint(point) : "";
          offset += token.length;
          continue;
        }
      }
      value += text[offset]!;
      offset += 1;
    }
    if (offset < text.length) {
      let closingLength = delimiter.length;
      if (delimiter.length === 3) {
        while (closingLength < 5 && text[offset + closingLength] === quote) closingLength += 1;
        value += quote.repeat(closingLength - 3);
      }
      offset += closingLength;
    }
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
  const rejectDeviceKey = (value: string, start: number, length: number) => {
    if (value.includes("{{device:")) diagnostics.push({
      code: "DEVICE_PLACEHOLDER_NOT_SCALAR", severity: "error",
      message: "设备变量不能用于键名。", range: rangeAt(text, start, length),
    });
  };

  if (format === "json" || format === "jsonc") {
    const errors: { error: number; offset: number; length: number }[] = [];
    visitJson(text, {
      onError(error, offset, length) {
        errors.push({ error, offset, length });
      },
      onObjectProperty(value, offset, length) {
        rejectDeviceKey(value, offset, length);
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
      Scalar(_key, node, path) {
        const inKey = _key === "key" || path.some((ancestor, index) =>
          isPair(ancestor) && ancestor.key === (path[index + 1] ?? node));
        if (inKey && isScalar(node) && typeof node.value === "string" && node.range) {
          rejectDeviceKey(node.value, node.range[0], node.range[1] - node.range[0]);
        }
        if (!inKey && isScalar(node) && typeof node.value === "string" && node.range) {
          // 块标量范围含末尾换行；保留节点分隔符，避免规范化后粘连下一键。
          const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
          if (block && text.slice(node.range[0], text.indexOf("\n", node.range[0])).includes("{{device:")) {
            diagnostics.push({
              code: "DEVICE_PLACEHOLDER_NOT_SCALAR", severity: "error",
              message: "设备变量不能用于块标量的头部注释。",
              range: rangeAt(text, node.range[0], node.range[1] - node.range[0]),
            });
          }
          const trailingBreak = block ? (text.slice(node.range[0], node.range[1]).match(/\r?\n$/)?.[0].length ?? 0) : 0;
          candidates.push({ start: node.range[0], end: node.range[1] - trailingBreak, value: node.value });
        }
      },
    });
  } else if (format === "toml") {
    diagnostics.push(...await lintToml(text));
    for (const token of scanTomlStrings(text)) {
      if (token.valuePosition) candidates.push({ start: token.start, end: token.end, value: token.value });
      else rejectDeviceKey(token.value, token.start, token.end - token.start);
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

  // 设备变量与秘密共用标量解析，但计划只来自原始模板，不能扫描秘密展开后的文本。
  const deviceCandidates = candidates.filter(({ value }) => value === "{{device:name}}");
  for (const candidate of candidates) {
    if (candidate.value.includes("{{device:") && candidate.value !== "{{device:name}}") {
      diagnostics.push({
        code: "DEVICE_PLACEHOLDER_NOT_SCALAR",
        severity: "error",
        message: "设备变量只支持完整字符串值 {{device:name}}。",
        range: rangeAt(text, candidate.start, candidate.end - candidate.start),
      });
    }
  }
  for (const match of text.matchAll(/\{\{device:[^}\r\n]*(?:\}\})?/g)) {
    if (!deviceCandidates.some(({ start, end }) => match.index >= start && match.index < end)) {
      diagnostics.push({
        code: "DEVICE_PLACEHOLDER_NOT_SCALAR",
        severity: "error",
        message: "设备变量不能出现在键名、注释或拼接字符串中，也不支持未知变量。",
        range: rangeAt(text, match.index, match[0].length),
      });
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
  diagnostics.push(...scanInlineSecrets(text));

  const deviceNameSlots: { start: number; end: number; format: SecretFormat }[] = [];
  const allReplacements = [
    ...replacements,
    ...deviceCandidates.map((candidate) => ({ ...candidate, value: JSON.stringify("{{device:name}}"), slot: null })),
  ].toSorted((left, right) => left.start - right.start);
  let shift = 0;
  for (const replacement of allReplacements) {
    if (replacement.slot === null) {
      deviceNameSlots.push({ start: replacement.start + shift, end: replacement.start + shift + replacement.value.length, format });
    }
    shift += replacement.value.length - (replacement.end - replacement.start);
  }

  let output = text;
  for (const replacement of allReplacements.toReversed()) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return {
    text: output,
    slots: [...new Set(replacements.map(({ slot }) => slot))].sort(),
    sensitive: replacements.length > 0,
    diagnostics,
    deviceNameSlots,
  };
}

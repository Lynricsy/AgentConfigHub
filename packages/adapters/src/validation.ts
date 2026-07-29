import { Ajv, type ValidateFunction } from "ajv";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";

import type { AgentId, Diagnostic } from "@agent-config-hub/protocol";

import type { AdapterFile } from "./contract.js";
import { ADAPTER_SCHEMA_SNAPSHOTS } from "./schema-snapshots.js";

export { ADAPTER_SCHEMA_SNAPSHOTS } from "./schema-snapshots.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validatorByAgent = Object.fromEntries(
  Object.entries(ADAPTER_SCHEMA_SNAPSHOTS).map(([agentId, snapshot]) => [
    agentId,
    ajv.compile(snapshot.schema),
  ]),
) as Record<AgentId, ValidateFunction>;

function syntaxDiagnostic(message: string): Diagnostic {
  return { code: "FORMAT_SYNTAX_ERROR", severity: "error", message };
}

function isPrimaryConfig(file: AdapterFile): boolean {
  return /(?:^|\/)(?:settings\.json|config\.toml|config\.yml|opencode\.jsonc?|models\.json)$/.test(
    file.target.relativePath,
  );
}

function parseMarkdownFrontmatter(text: string): Diagnostic[] {
  if (!text.startsWith("---\n")) return [];
  const end = text.indexOf("\n---", 4);
  if (end === -1) return [syntaxDiagnostic("Markdown frontmatter is not terminated.")];
  const document = parseDocument(text.slice(4, end));
  return document.errors.map((error) => syntaxDiagnostic(error.message));
}

export async function validateAdapterFile(file: AdapterFile): Promise<readonly Diagnostic[]> {
  if (file.format === "binary") return [];
  if (file.text === null) return [syntaxDiagnostic("Text formats require UTF-8 content.")];
  const diagnostics: Diagnostic[] = [];
  let parsed: unknown;
  try {
    switch (file.format) {
      case "json":
        parsed = JSON.parse(file.text) as unknown;
        break;
      case "jsonc": {
        const errors: ParseError[] = [];
        parsed = parseJsonc(file.text, errors, { allowTrailingComma: true, disallowComments: false });
        for (const error of errors) diagnostics.push(syntaxDiagnostic(`Invalid JSONC syntax (${error.error}).`));
        break;
      }
      case "yaml": {
        const document = parseDocument(file.text);
        diagnostics.push(...document.errors.map((error) => syntaxDiagnostic(error.message)));
        parsed = document.toJS() as unknown;
        break;
      }
      case "toml":
        parsed = parseToml(file.text);
        break;
      case "markdown":
        diagnostics.push(...parseMarkdownFrontmatter(file.text));
        break;
      case "dotenv":
        for (const [index, line] of file.text.split("\n").entries()) {
          if (line.trim() && !line.trimStart().startsWith("#") && !/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
            diagnostics.push({
              ...syntaxDiagnostic("Invalid dotenv assignment."),
              range: { startLine: index + 1, startColumn: 1, endLine: index + 1, endColumn: line.length + 1 },
            });
          }
        }
        break;
      case "text":
        break;
    }
  } catch (error) {
    diagnostics.push(syntaxDiagnostic(error instanceof Error ? error.message : `Invalid ${file.format} syntax.`));
  }

  if (diagnostics.some(({ severity }) => severity === "error") || !isPrimaryConfig(file)) return diagnostics;
  const snapshot = ADAPTER_SCHEMA_SNAPSHOTS[file.agentId];
  const validator = validatorByAgent[file.agentId];
  if (!validator(parsed)) {
    for (const error of validator.errors ?? []) diagnostics.push({
      code: "SCHEMA_VALIDATION_ERROR",
      severity: "error",
      message: `${error.instancePath || "/"} ${error.message ?? "does not match the vendor schema"}.`,
    });
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const properties = snapshot.schema.properties as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (!(key in properties)) diagnostics.push({
        code: "UNKNOWN_SCHEMA_KEY",
        severity: "warning",
        message: `Unknown ${file.agentId} configuration key: ${key}.`,
      });
    }
  }
  return diagnostics;
}

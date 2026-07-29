import { describe, expect, it } from "vitest";

import { replaceSecretScalars, type SecretFormat } from "../src/security/secret-replacement.js";

const fixtures: { format: SecretFormat; source: string; expected: string }[] = [
  { format: "json", source: '{"token":"{{secret:MODEL_API_KEY}}"}', expected: '{"token":"resolved-value"}' },
  { format: "jsonc", source: '{"token":"{{secret:MODEL_API_KEY}}",}', expected: '{"token":"resolved-value",}' },
  { format: "yaml", source: 'token: "{{secret:MODEL_API_KEY}}"\n', expected: 'token: "resolved-value"\n' },
  { format: "toml", source: 'token = "{{secret:MODEL_API_KEY}}"\n', expected: 'token = "resolved-value"\n' },
  { format: "dotenv", source: "TOKEN={{secret:MODEL_API_KEY}}\n", expected: 'TOKEN="resolved-value"\n' },
];

describe("replaceSecretScalars", () => {
  for (const fixture of fixtures) {
    it(`replaces a complete ${fixture.format} string scalar with format escaping`, async () => {
      const result = await replaceSecretScalars(
        fixture.source,
        fixture.format,
        (slot) => slot === "MODEL_API_KEY" ? "resolved-value" : undefined,
      );
      expect(result.text).toBe(fixture.expected);
      expect(result.slots).toEqual(["MODEL_API_KEY"]);
      expect(result.sensitive).toBe(true);
      expect(result.diagnostics).toEqual([]);
    });
  }

  it("rejects fragments, comments, keys, and missing bindings without echoing values", async () => {
    const fragment = await replaceSecretScalars(
      '{"{{secret:KEY_NAME}}":"prefix-{{secret:MODEL_API_KEY}}"}',
      "json",
      () => "must-not-appear-in-diagnostic",
    );
    expect(fragment.diagnostics.map(({ code }) => code)).toEqual([
      "SECRET_PLACEHOLDER_NOT_SCALAR",
      "SECRET_PLACEHOLDER_NOT_SCALAR",
    ]);
    expect(JSON.stringify(fragment.diagnostics)).not.toContain("must-not-appear");

    const yamlKey = await replaceSecretScalars(
      "\"{{secret:KEY_NAME}}\": value\n",
      "yaml",
      () => "must-not-replace-key",
    );
    expect(yamlKey.text).toBe("\"{{secret:KEY_NAME}}\": value\n");
    expect(yamlKey.diagnostics).toMatchObject([{ code: "SECRET_PLACEHOLDER_NOT_SCALAR" }]);

    const tomlInlineKey = await replaceSecretScalars(
      "outer = { \"{{secret:KEY_NAME}}\" = \"value\" }\n",
      "toml",
      () => "must-not-replace-key",
    );
    expect(tomlInlineKey.text).toBe("outer = { \"{{secret:KEY_NAME}}\" = \"value\" }\n");
    expect(tomlInlineKey.diagnostics).toMatchObject([{ code: "SECRET_PLACEHOLDER_NOT_SCALAR" }]);

    const missing = await replaceSecretScalars(
      "token: '{{secret:UNBOUND}}'\n",
      "yaml",
      () => undefined,
    );
    expect(missing.diagnostics).toMatchObject([{ code: "SECRET_BINDING_MISSING", severity: "error" }]);
  });

  it("blocks high-confidence inline credentials without returning the matched value", async () => {
    const secret = `sk-${"a".repeat(30)}`;
    const result = await replaceSecretScalars(`token = "${secret}"`, "toml", () => undefined);
    expect(result.diagnostics).toMatchObject([{ code: "INLINE_SECRET_DETECTED" }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });
});

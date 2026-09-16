import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

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

  it("设备计划只包含模板标量，不重新解释秘密值", async () => {
    const result = await replaceSecretScalars(
      '{"secret":"{{secret:KEY}}","name":"{{device:name}}","other":"{{device:name}}"}',
      "json", () => '带引号"和换行\n{{device:name}}',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.deviceNameSlots).toHaveLength(2);
    let installed = result.text;
    const name = '设备"甲\n{{device:name}}';
    for (const slot of result.deviceNameSlots.toReversed()) {
      expect(installed.slice(slot.start, slot.end)).toBe('"{{device:name}}"');
      installed = installed.slice(0, slot.start) + JSON.stringify(name) + installed.slice(slot.end);
    }
    expect(JSON.parse(installed)).toEqual({ secret: '带引号"和换行\n{{device:name}}', name, other: name });
  });

  it("设备块标量规范化后保留 YAML 后续节点边界", async () => {
    const result = await replaceSecretScalars(
      'device: |-\r\n  {{device:name}}\r\nother: value\r\nsecond: "{{device:name}}"\r\n',
      "yaml", () => undefined,
    );
    expect(result.diagnostics).toEqual([]);
    let installed = result.text;
    for (const slot of result.deviceNameSlots.toReversed()) {
      installed = installed.slice(0, slot.start) + JSON.stringify("登记设备") + installed.slice(slot.end);
    }
    expect(parseYaml(installed)).toEqual({ device: "登记设备", other: "value", second: "登记设备" });
  });

  it("拒绝设备变量的拼接、键名、注释和未知变量", async () => {
    for (const source of [
      '{"name":"前缀{{device:name}}"}',
      '{"{{device:name}}":"value"}',
      '{"name":"{{device:hostname}}"}',
      '// {{device:name}}\n{"name":"value"}',
      '{"name":"{{device:unknown"}',
    ]) {
      const result = await replaceSecretScalars(source, "jsonc", () => undefined);
      expect(result.diagnostics.some(({ code }) => code === "DEVICE_PLACEHOLDER_NOT_SCALAR")).toBe(true);
    }
    const blockComment = await replaceSecretScalars(
      'device: |- # {{device:hostname}}\n  {{device:name}}\n',
      "yaml", () => undefined,
    );
    expect(blockComment.diagnostics.some(({ code }) => code === "DEVICE_PLACEHOLDER_NOT_SCALAR")).toBe(true);
  });

  it("所有结构化格式都标记完整设备标量", async () => {
    for (const fixture of fixtures) {
      const result = await replaceSecretScalars(fixture.source.replace("{{secret:MODEL_API_KEY}}", "{{device:name}}"), fixture.format, () => undefined);
      expect(result.diagnostics).toEqual([]);
      const slot = result.deviceNameSlots[0]!;
      expect(result.text.slice(slot.start, slot.end)).toBe('"{{device:name}}"');
      expect(slot.format).toBe(fixture.format);
      expect(result.sensitive).toBe(false);
    }
  });
});

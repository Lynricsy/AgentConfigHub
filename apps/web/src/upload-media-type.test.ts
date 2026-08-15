import { describe, expect, it } from "vitest";

import { uploadedMediaTypeFor } from "./upload-media-type.js";

describe("uploadedMediaTypeFor", () => {
  it("keeps a dotenv upload on the text path when the browser reports no MIME", () => {
    // 服务端只对 text/* 与 application/{json,yaml,toml} 置 monacoEligible,
    // 该字段就是上传请求里的 utf8;推断成二进制会让 dotenv 跳过校验与 secret 替换。
    expect(uploadedMediaTypeFor({ name: ".env", type: "" })).toBe("text/plain");
  });

  it("keeps a dotenv upload on the text path when the browser normalizes to generic binary", () => {
    // Chromium 对未知扩展名不一定给空串,也会归一成 application/octet-stream,
    // 两种"不知道"必须走同一条按文件名兜底的路径。
    expect(uploadedMediaTypeFor({ name: ".env", type: "application/octet-stream" })).toBe("text/plain");
  });

  it("applies the same .env suffix rule the server uses to detect dotenv", () => {
    expect(uploadedMediaTypeFor({ name: "staging.env", type: "" })).toBe("text/plain");
  });

  it("falls back to binary for an unknown extension without a MIME", () => {
    expect(uploadedMediaTypeFor({ name: "weights.bin", type: "" })).toBe("application/octet-stream");
    expect(uploadedMediaTypeFor({ name: "weights.bin", type: "application/octet-stream" }))
      .toBe("application/octet-stream");
  });

  it("keeps inferring known text extensions without a MIME", () => {
    expect(uploadedMediaTypeFor({ name: "settings.json", type: "" })).toBe("application/json");
    expect(uploadedMediaTypeFor({ name: "config.toml", type: "" })).toBe("application/toml");
    expect(uploadedMediaTypeFor({ name: "AGENTS.md", type: "" })).toBe("text/markdown");
  });

  it("prefers the MIME the browser reports over the name guess", () => {
    expect(uploadedMediaTypeFor({ name: "bundle.tar.gz", type: "application/gzip" }))
      .toBe("application/gzip");
  });
});

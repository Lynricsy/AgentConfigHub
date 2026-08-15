export interface UploadedFile {
  readonly name: string;
  readonly type: string;
}

/**
 * 推断上传文件要发给 /api/v1/blobs 的 media type。
 *
 * 浏览器只按扩展名猜 MIME,对 `.env` 这类没有注册扩展名的文件要么给出空 `File.type`,
 * 要么归一成通用的 application/octet-stream —— 两者都表示"浏览器不知道",都必须由
 * 文件名兜底。若原样上报二进制,服务端会判定 monacoEligible 为 false,文件以
 * utf8: false 入库,dotenv 的语法校验与 secret 替换都不会执行。
 * 扩展名同样未知时仍然落回 application/octet-stream,二进制文件的行为不变。
 */
export function uploadedMediaTypeFor(file: UploadedFile): string {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const lower = file.name.toLocaleLowerCase("en-US");
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".toml")) return "application/toml";
  if (lower.endsWith(".md")) return "text/markdown";
  // `.env` 与服务端 fileFormat 的 dotenv 判定保持同一条后缀规则
  // (apps/server/src/services/publish-service.ts)。
  if (lower.endsWith(".sh") || lower.endsWith(".txt") || lower.endsWith(".env")) return "text/plain";
  return "application/octet-stream";
}

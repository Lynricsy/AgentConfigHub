import { z } from "zod";

// omp-home 下的附加安装声明。它随 Release 下发，CLI 在 pull 成功写盘后据此
// 安装 OMP 插件、同步 Git 技能仓库；声明只允许受限的字面值，绝不作为 shell 执行。
export const OMP_EXTRAS_PATH = "agent-config-hub.json";

// 技能仓库克隆到 `<omp-home>/skill-repositories/<name>`，
// 由 config.yml 的 `skills.customDirectories` 指向其中的技能目录。
export const OMP_SKILL_REPOSITORY_DIRECTORY = "skill-repositories";

// npm 包名加可选的版本/标签；首字符限制为 `@` 或字母数字，杜绝被当作命令行选项。
const PluginSpec = z.string().regex(
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9^~][A-Za-z0-9._^~+-]*)?$/,
  "Plugin must be an npm package spec such as @scope/name or @scope/name@latest.",
);

const RepositoryName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Repository name must be lowercase kebab-case.");

const HttpsUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !/\s/.test(value);
  } catch {
    return false;
  }
}, "Repository URL must be an https:// URL without embedded credentials.");

const GitRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Ref must be a branch or tag name.")
  .refine((value) => !value.includes("..") && !value.endsWith(".lock") && !value.endsWith("/"), "Ref is not a valid Git ref.");

export const SkillRepository = z.object({
  name: RepositoryName,
  url: HttpsUrl,
  ref: GitRef.default("main"),
}).strict();

function packageName(spec: string): string {
  const versionAt = spec.indexOf("@", 1);
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

export const OmpExtrasV1 = z.object({
  version: z.literal(1),
  plugins: z.array(PluginSpec).default([]),
  skillRepositories: z.array(SkillRepository).default([]),
}).strict().superRefine((value, context) => {
  const packages = value.plugins.map(packageName);
  if (new Set(packages).size !== packages.length) {
    context.addIssue({ code: "custom", path: ["plugins"], message: "A plugin package is declared more than once." });
  }
  const names = value.skillRepositories.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", path: ["skillRepositories"], message: "A skill repository name is declared more than once." });
  }
});

export type SkillRepository = z.infer<typeof SkillRepository>;
export type OmpExtrasV1 = z.infer<typeof OmpExtrasV1>;

import { isAbsolute as posixIsAbsolute, join as posixJoin, relative as posixRelative, resolve as posixResolve, sep as posixSeparator } from "node:path/posix";
import { isAbsolute as windowsIsAbsolute, join as windowsJoin, relative as windowsRelative, resolve as windowsResolve, sep as windowsSeparator } from "node:path/win32";

import type { LogicalTarget } from "@agent-config-hub/protocol";

import type { AgentAdapter, ClientPathContext, ManagedSurface } from "./contract.js";

const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const windowsInvalidCharacter = /[<>:\"|?*\u0000-\u001F]/;
const excludedByAgent: Record<AgentAdapter["id"], readonly string[]> = {
  "claude-code": [
    ".claude.json",
    "projects/**",
    "history.jsonl",
    "todos/**",
    "plugins/cache/**",
    "plugins/installed/**",
  ],
  codex: ["auth.json", "sessions/**", "logs/**", "state.sqlite", "state.db", "cache/**", "downloads/**"],
  opencode: ["node_modules/**", "auth.json", "auth/**", "runtime/**"],
  pi: ["auth.json", "trust.json", "sessions/**", "packages/npm/**", "packages/git/**", "cache/**"],
  omp: [
    "agent.db",
    "sessions/**",
    "blobs/**",
    "managed-skills/**",
    "**/node_modules/**",
    "install-state.json",
    ".install-state.json",
  ],
  grok: ["auth.json", "credentials/**", "trusted_folders.toml", "bundled/**", "sessions/**", "memory/**", "cache/**", "system/**"],
};

function exclusionMatches(pattern: string, relativePath: string): boolean {
  if (pattern === "**/node_modules/**") return relativePath.split("/").includes("node_modules");
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3);
    return relativePath.startsWith(`${directory}/`);
  }
  return pattern === relativePath;
}


export class UnsafeTargetError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnsafeTargetError";
    this.code = code;
  }
}

export function assertSafeRelativePath(relativePath: string): void {
  if (relativePath.includes("\0")) throw new UnsafeTargetError("PATH_NUL", "Target path contains NUL.");
  if (relativePath.includes("\\")) {
    throw new UnsafeTargetError("PATH_SEPARATOR", "Logical target paths must use forward slashes.");
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("//")) {
    throw new UnsafeTargetError("PATH_ABSOLUTE", "Target path must be relative.");
  }
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new UnsafeTargetError("PATH_EMPTY_SEGMENT", "Target path contains an empty segment.");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new UnsafeTargetError("PATH_TRAVERSAL", "Target path contains traversal segments.");
    }
    if (windowsInvalidCharacter.test(segment)) {
      throw new UnsafeTargetError("WINDOWS_INVALID_CHARACTER", "Target path contains a Windows-invalid character.");
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new UnsafeTargetError("WINDOWS_PATH_SUFFIX", "Windows paths cannot end in a dot or space.");
    }
    if (windowsDeviceName.test(segment)) {
      throw new UnsafeTargetError("WINDOWS_DEVICE_NAME", "Target path uses a Windows device name.");
    }
  }
}

function surfaceMatches(surface: ManagedSurface, target: LogicalTarget): boolean {
  if (surface.root !== target.root) return false;
  if (surface.pattern.endsWith("/**")) {
    const directory = surface.pattern.slice(0, -3);
    return target.relativePath.startsWith(`${directory}/`) && target.relativePath.length > directory.length + 1;
  }
  if (surface.pattern.startsWith("*.") && !target.relativePath.includes("/")) {
    return target.relativePath.endsWith(surface.pattern.slice(1));
  }
  return surface.pattern === target.relativePath;
}

export function assertAllowedTarget(
  adapter: AgentAdapter,
  target: LogicalTarget,
  options: { allowReserved?: boolean } = {},
): ManagedSurface {
  if (excludedByAgent[adapter.id].some((pattern) => exclusionMatches(pattern, target.relativePath))) {
    throw new UnsafeTargetError("TARGET_EXCLUDED", `${target.relativePath} is explicitly excluded for ${adapter.id}.`);
  }
  assertSafeRelativePath(target.relativePath);
  if (!adapter.roots.includes(target.root)) {
    throw new UnsafeTargetError("ROOT_NOT_ALLOWED", `${target.root} is not managed by ${adapter.id}.`);
  }
  const surface = adapter.surfaces.find((candidate) => surfaceMatches(candidate, target));
  if (!surface) throw new UnsafeTargetError("TARGET_NOT_ALLOWED", `${target.relativePath} is not managed by ${adapter.id}.`);
  if (surface.reserved && !options.allowReserved) {
    throw new UnsafeTargetError("TARGET_RESERVED", `${target.relativePath} is generated and cannot be uploaded.`);
  }
  return surface;
}

export function assertNoLogicalTargetCollisions(targets: readonly LogicalTarget[]): void {
  const seen = new Map<string, LogicalTarget>();
  for (const target of targets) {
    assertSafeRelativePath(target.relativePath);
    const key = `${target.root}\0${target.relativePath.toLocaleLowerCase("en-US")}`;
    const previous = seen.get(key);
    if (previous) {
      throw new UnsafeTargetError(
        "TARGET_COLLISION",
        `${previous.root}/${previous.relativePath} collides with ${target.root}/${target.relativePath}.`,
      );
    }
    seen.set(key, target);
  }
}

export function resolveTargetPath(
  adapter: AgentAdapter,
  target: LogicalTarget,
  context: ClientPathContext,
): string {
  assertAllowedTarget(adapter, target, { allowReserved: true });
  const root = adapter.resolveRoot(target.root, context);
  const windows = context.platform === "win32";
  const isAbsolute = windows ? windowsIsAbsolute : posixIsAbsolute;
  const resolve = windows ? windowsResolve : posixResolve;
  const relative = windows ? windowsRelative : posixRelative;
  const join = windows ? windowsJoin : posixJoin;
  const separator = windows ? windowsSeparator : posixSeparator;
  if (!isAbsolute(root)) throw new UnsafeTargetError("ROOT_NOT_ABSOLUTE", `${target.root} must resolve to an absolute path.`);
  const destination = resolve(join(root, ...target.relativePath.split("/")));
  const fromRoot = relative(resolve(root), destination);
  if (fromRoot === ".." || fromRoot.startsWith(`..${separator}`) || isAbsolute(fromRoot)) {
    throw new UnsafeTargetError("PATH_ESCAPES_ROOT", `${target.relativePath} escapes ${target.root}.`);
  }
  return destination;
}

export function assertNoResolvedTargetCollisions(
  entries: readonly { adapter: AgentAdapter; target: LogicalTarget }[],
  context: ClientPathContext,
): void {
  const seen = new Map<string, string>();
  for (const { adapter, target } of entries) {
    const destination = resolveTargetPath(adapter, target, context);
    const key = context.platform === "win32" ? destination.toLocaleLowerCase("en-US") : destination;
    const previous = seen.get(key);
    if (previous) throw new UnsafeTargetError("TARGET_COLLISION", `${previous} and ${destination} resolve to the same file.`);
    seen.set(key, destination);
  }
}

import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Copy,
  Database,
  Dot,
  Download,
  FileCode,
  GitMerge,
  Info,
  LoaderCircle,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { z } from "zod";

import { AgentId, type Diagnostic, type TargetRootId } from "@agent-config-hub/protocol";

import {
  AdapterList,
  ApiClientError,
  ConfigSetDetail,
  ResourceList,
  ValidationResult,
  api,
  downloadBlob,
  mutate,
  uploadBlob,
  type AdapterMetadata,
  type DraftFile,
  type ConfigSetDetail as ConfigSetDetailData,
  type ResourceList as ResourceData,
  targetKey,
} from "../api.js";
import { ErrorNotice } from "../auth.js";
import { AutosaveCoordinator, type AutosaveState } from "../autosave.js";
import { cn } from "../lib/cn.js";
import { defineMonacoThemes, monacoThemeFor } from "../monaco-theme.js";
import { useAppStatus } from "../shell.js";
import { useTheme } from "../theme.js";
import { Badge } from "../ui/badge.js";
import { Button, buttonVariants } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { Checkbox } from "../ui/checkbox.js";
import { Empty } from "../ui/empty.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import { Loading } from "../ui/spinner.js";

const RevisionResult = z.object({ revision: z.number().int() });
const MONACO_LIMIT = 2 * 1024 * 1024;

function languageFor(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".sh")) return "shell";
  return "plaintext";
}

function mediaTypeFor(path: string): string {
  const language = languageFor(path);
  if (language === "json") return "application/json";
  if (language === "yaml") return "application/yaml";
  if (language === "toml") return "application/toml";
  if (language === "markdown") return "text/markdown";
  return "text/plain";
}
function uploadedMediaTypeFor(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "application/json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml";
  if (lower.endsWith(".toml")) return "application/toml";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".sh") || lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}


function newFileText(path: string): string {
  return languageFor(path) === "json" ? "{}\n" : "";
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.startsWith("\\") &&
    !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..");
}

function surfaceAllows(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0001")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0001", ".*");
  return new RegExp(`^${escaped}$`, "u").test(path);
}
function targetForPath(
  adapter: AdapterMetadata,
  relativePath: string,
): { root: TargetRootId; relativePath: string } {
  const roots = new Set<TargetRootId>();
  if (safeRelativePath(relativePath)) {
    for (const surface of adapter.surfaces) {
      if (!surface.reserved && surfaceAllows(surface.pattern, relativePath)) roots.add(surface.root);
    }
  }
  if (roots.size === 0) {
    throw new Error(`${relativePath} is not a managed path for ${adapter.id}.`);
  }
  if (roots.size > 1) throw new Error(`${relativePath} matches more than one managed root.`);
  return { root: [...roots][0]!, relativePath };
}


interface SyntaxMessage {
  message: string;
  line: number;
  column: number;
}

function useSyntaxDiagnostics(text: string, language: string, file: DraftFile): Diagnostic[] {
  const [messages, setMessages] = useState<SyntaxMessage[]>([]);
  const requestId = useRef(0);
  const worker = useMemo(() => new Worker(new URL("../syntax.worker.ts", import.meta.url), { type: "module" }), []);
  useEffect(() => () => worker.terminate(), [worker]);
  useEffect(() => {
    const id = ++requestId.current;
    const listener = (event: MessageEvent<{ id: number; diagnostics: SyntaxMessage[] }>) => {
      if (event.data.id === id) setMessages(event.data.diagnostics);
    };
    worker.addEventListener("message", listener);
    worker.postMessage({ id, text, language });
    return () => worker.removeEventListener("message", listener);
  }, [file.id, language, text, worker]);
  return useMemo(() => messages.map((message) => ({
    code: "LOCAL_SYNTAX",
    severity: "error",
    message: message.message,
    target: { root: file.root, relativePath: file.relativePath },
    range: {
      startLine: message.line,
      startColumn: message.column,
      endLine: message.line,
      endColumn: message.column + 1,
    },
  })), [file.relativePath, file.root, messages]);
}

function TextFileEditor({
  configSetId,
  initialRevision,
  file,
  adapter,
}: {
  configSetId: string;
  initialRevision: number;
  file: DraftFile;
  adapter: AdapterMetadata;
}) {
  const queryClient = useQueryClient();
  const { setBlockingDiagnostics } = useAppStatus();
  const { resolved } = useTheme();
  const language = languageFor(file.relativePath);
  const modelUri = `inmemory://agent-config-hub/${configSetId}/${file.agentId}/${file.root}/${file.relativePath}`;
  const source = useQuery({
    queryKey: ["blob-text", file.blobSha256],
    queryFn: async () => await (await downloadBlob(file.blobSha256)).text(),
  });
  const [text, setText] = useState("");
  const [saveState, setSaveState] = useState<AutosaveState>("saved");
  const [serverConflictText, setServerConflictText] = useState<string | null>(null);
  const savedText = useRef("");
  const loadedBlob = useRef<string | null>(null);
  const revision = useRef(initialRevision);
  const monaco = useRef<Monaco | null>(null);
  const model = useRef<Parameters<OnMount>[0] | null>(null);
  const localDiagnostics = useSyntaxDiagnostics(text, language, file);
  const [serverDiagnostics, setServerDiagnostics] = useState<Diagnostic[]>([]);
  const validationRequest = useRef(0);

  const coordinator = useMemo(() => new AutosaveCoordinator({
    initialText: "",
    save: async (nextText) => {
      const descriptor = await uploadBlob(new Blob([nextText], { type: file.mediaType }));
      const result = await mutate(
        `/api/v1/config-sets/${configSetId}/files`,
        RevisionResult,
        {
          agentId: file.agentId,
          target: { root: file.root, relativePath: file.relativePath },
          blobSha256: descriptor.sha256,
          mediaType: file.mediaType,
          utf8: true,
          executable: file.executable,
        },
        { method: "PUT", revision: revision.current },
      );
      revision.current = result.data.revision;
      savedText.current = nextText;
      queryClient.setQueryData(["blob-text", descriptor.sha256], nextText);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    },
    isConflict: (error) => error instanceof ApiClientError && error.code === "REVISION_CONFLICT",
    onConflict: async () => {
      const latest = await api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail);
      revision.current = latest.configSet.draftRevision;
      const currentFile = latest.files.find(({ id }) => id === file.id);
      setServerConflictText(currentFile ? await (await downloadBlob(currentFile.blobSha256)).text() : "");
    },
    onState: setSaveState,
  }), [configSetId, file.id, queryClient]);

  useEffect(() => {
    if (source.data === undefined || loadedBlob.current === file.blobSha256) return;
    if (loadedBlob.current !== null && text !== savedText.current) return;
    loadedBlob.current = file.blobSha256;
    savedText.current = source.data;
    coordinator.setSavedText(source.data);
    setText(source.data);
  }, [coordinator, file.blobSha256, source.data, text]);
  useEffect(() => {
    revision.current = Math.max(revision.current, initialRevision);
  }, [initialRevision]);

  useEffect(() => {
    if (source.data === undefined || coordinator.conflicted || text === savedText.current) return;
    setSaveState("unsaved");
    const timer = window.setTimeout(() => void coordinator.submit(text), 400);
    return () => window.clearTimeout(timer);
  }, [coordinator, source.data, text]);

  useEffect(() => {
    if (source.data === undefined) return;
    const requestId = ++validationRequest.current;
    const timer = window.setTimeout(() => {
      void mutate(
        "/api/v1/validate-file",
        ValidationResult,
        {
          agentId: file.agentId,
          target: { root: file.root, relativePath: file.relativePath },
          mediaType: file.mediaType,
          text,
          executable: file.executable,
        },
      ).then(({ data }) => {
        if (validationRequest.current === requestId) setServerDiagnostics(data.diagnostics);
      }).catch(() => {
        if (validationRequest.current === requestId) setServerDiagnostics([{
          code: "SERVER_VALIDATION_UNAVAILABLE",
          severity: "warning",
          message: "Authoritative server validation is temporarily unavailable.",
          target: { root: file.root, relativePath: file.relativePath },
        }]);
      });
    }, 800);
    return () => {
      window.clearTimeout(timer);
      if (validationRequest.current === requestId) validationRequest.current += 1;
    };
  }, [file, source.data, text]);

  const diagnostics = useMemo(
    () => [...localDiagnostics, ...serverDiagnostics],
    [localDiagnostics, serverDiagnostics],
  );
  useEffect(() => {
    setBlockingDiagnostics(diagnostics.filter(({ severity }) => severity === "error").length);
    if (!monaco.current || !model.current) return;
    monaco.current.editor.setModelMarkers(model.current.getModel()!, "agent-config-hub", diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity === "error" ? monaco.current!.MarkerSeverity.Error : monaco.current!.MarkerSeverity.Warning,
      startLineNumber: diagnostic.range?.startLine ?? 1,
      startColumn: diagnostic.range?.startColumn ?? 1,
      endLineNumber: diagnostic.range?.endLine ?? 1,
      endColumn: diagnostic.range?.endColumn ?? 2,
    })));
  }, [diagnostics, setBlockingDiagnostics]);
  useEffect(() => () => setBlockingDiagnostics(0), [setBlockingDiagnostics]);

  const beforeMount = (instance: Monaco) => {
    monaco.current = instance;
    defineMonacoThemes(instance);
    if (language === "json") instance.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: file.relativePath.endsWith(".jsonc"),
      schemas: [{
        uri: adapter.schemaSnapshot.source,
        fileMatch: [modelUri],
        schema: adapter.schemaSnapshot.schema,
      }],
    });
  };
  const onMount: OnMount = (editor) => { model.current = editor; };

  if (source.isPending && loadedBlob.current === null) return <Loading label="Loading file…" />;
  if (source.error && loadedBlob.current === null) return <ErrorNotice error={source.error} />;

  const saveStateIcon = saveState === "saved"
    ? <Check size={15} strokeWidth={1.5} aria-hidden="true" />
    : saveState === "saving"
      ? <LoaderCircle className="animate-spin" size={15} strokeWidth={1.5} aria-hidden="true" />
      : saveState === "unsaved"
        ? <Dot size={15} strokeWidth={1.5} aria-hidden="true" />
        : <GitMerge size={15} strokeWidth={1.5} aria-hidden="true" />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 text-xs text-muted-foreground">
        <span className="text-primary">{saveStateIcon}</span>
        <span className={cn("save-state font-medium", saveState === "conflict" && "text-destructive", saveState === "unsaved" && "text-warning")}>{saveState}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[0.6875rem]">{modelUri}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Editor
          height="100%"
          language={language}
          path={modelUri}
          value={text}
          onChange={(value) => setText(value ?? "")}
          beforeMount={beforeMount}
          onMount={onMount}
          keepCurrentModel
          saveViewState
          theme={monacoThemeFor(resolved)}
          options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, wordWrap: "on", automaticLayout: true }}
        />
      </div>
      <DiagnosticsPanel diagnostics={diagnostics} />
      {saveState === "conflict" && (
        <div
          className="conflict-panel max-h-64 shrink-0 overflow-y-auto border-t border-destructive/40 bg-destructive/5 p-4"
          role="alert"
        >
          <div>
            <h3 className="text-sm font-semibold text-destructive">Resource revision changed</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Your model is preserved. Compare it with the current server value.
            </p>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Local model
              </p>
              <pre className="max-h-32 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs">{text}</pre>
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Server value
              </p>
              <pre className="max-h-32 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs">{serverConflictText}</pre>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(text)}>
              <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
              Copy local
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const serverText = serverConflictText ?? "";
                savedText.current = serverText;
                setText(serverText);
                coordinator.resolveConflict(serverText);
                setServerConflictText(null);
              }}
            >
              <RotateCcw size={15} strokeWidth={1.5} aria-hidden="true" />
              Reload server version
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <section className="max-h-40 min-h-0 shrink-0 overflow-y-auto border-t border-border bg-card">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <strong className="text-xs font-semibold">Diagnostics</strong>
        <Badge variant={diagnostics.some(({ severity }) => severity === "error") ? "destructive" : "outline"}>
          {diagnostics.length}
        </Badge>
      </header>
      {diagnostics.length === 0
        ? <p className="px-3 py-3 text-xs text-muted-foreground">No issues detected.</p>
        : (
          <div className="divide-y divide-border">
            {diagnostics.map((diagnostic, index) => {
              const Icon = diagnostic.severity === "error"
                ? CircleAlert
                : diagnostic.severity === "warning"
                  ? TriangleAlert
                  : Info;
              return (
                <div
                  className="grid grid-cols-[auto_auto_1fr] items-start gap-2 px-3 py-2 text-xs"
                  key={`${diagnostic.code}-${index}`}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5",
                      diagnostic.severity === "error"
                        ? "text-destructive"
                        : diagnostic.severity === "warning"
                          ? "text-warning"
                          : "text-primary",
                    )}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <Badge
                    variant={diagnostic.severity === "error"
                      ? "destructive"
                      : diagnostic.severity === "warning"
                        ? "warning"
                        : "outline"}
                  >
                    {diagnostic.code}
                  </Badge>
                  <p className="leading-5 text-muted-foreground">{diagnostic.message}</p>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

function BinaryFilePanel({
  configSetId,
  revision,
  file,
}: {
  configSetId: string;
  revision: number;
  file: DraftFile;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>();
  const replace = async (replacement: File) => {
    try {
      const descriptor = await uploadBlob(
        replacement,
        replacement.type || "application/octet-stream",
      );
      await mutate(
        `/api/v1/config-sets/${configSetId}/files`,
        RevisionResult,
        {
          agentId: file.agentId,
          target: { root: file.root, relativePath: file.relativePath },
          blobSha256: descriptor.sha256,
          mediaType: replacement.type || "application/octet-stream",
          utf8: false,
          executable: file.executable,
        },
        { method: "PUT", revision },
      );
      await queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] });
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <Card className="m-4 overflow-y-auto">
      <CardHeader>
        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">Binary asset</p>
        <CardTitle className="font-mono">{file.relativePath}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 font-mono text-xs">
          <dt className="text-muted-foreground">MIME</dt>
          <dd>{file.mediaType}</dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>{file.size.toLocaleString()} bytes</dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="break-all">{file.blobSha256}</dd>
        </dl>
        {error !== undefined && <ErrorNotice error={error} />}
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/v1/blobs/${file.blobSha256}`}
            download={file.relativePath.split("/").at(-1)}
          >
            <Download size={15} strokeWidth={1.5} aria-hidden="true" />
            Download
          </a>
          <label className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
            Replace
            <input
              className="sr-only"
              type="file"
              onChange={(event) => {
                const replacement = event.target.files?.[0];
                if (replacement) void replace(replacement);
              }}
            />
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigResourceBindings({
  configSetId,
  agentId,
  detail,
}: {
  configSetId: string;
  agentId: AgentId;
  detail: ConfigSetDetailData;
}) {
  const queryClient = useQueryClient();
  const [pendingResourceId, setPendingResourceId] = useState<string>();
  const [error, setError] = useState<unknown>();
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => api("/api/v1/resources", ResourceList),
  });
  const updateBinding = async (resourceId: string, selected: boolean, sortOrder: number) => {
    setPendingResourceId(resourceId);
    setError(undefined);
    try {
      await mutate(
        `/api/v1/config-sets/${configSetId}/configs/${agentId}/resources/${resourceId}`,
        RevisionResult,
        selected ? { sortOrder } : {},
        {
          method: selected ? "PUT" : "DELETE",
          revision: detail.configSet.draftRevision,
        },
      );
      const refreshed = await api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail);
      queryClient.setQueryData(["config-set", configSetId], refreshed);
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiClientError && cause.code === "REVISION_CONFLICT") {
        await queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] });
      }
    } finally {
      setPendingResourceId(undefined);
    }
  };
  const renderResources = (kind: ResourceData["resources"][number]["kind"]) => {
    const matches = resources.data?.resources.filter((resource) => resource.kind === kind) ?? [];
    return (
      <section className="flex min-h-0 flex-col gap-2">
        <h3 className="text-xs font-semibold">{kind === "instruction" ? "Instructions" : "Skills"}</h3>
        <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
          {matches.map((resource, index) => {
            const selection = detail.selectedResources.find((candidate) =>
              candidate.resourceId === resource.id && candidate.agentId === agentId);
            const selected = selection !== undefined;
            const order = selection?.sortOrder ?? index;
            return (
              <article
                className={cn(
                  "rounded-md border p-2 transition-colors duration-150",
                  selected ? "border-primary/40 bg-primary/5" : "border-border bg-card",
                )}
                key={resource.id}
              >
                <div className="flex items-start gap-2">
                  <Checkbox
                    aria-label={resource.name}
                    checked={selected}
                    className="mt-0.5"
                    disabled={pendingResourceId !== undefined}
                    onCheckedChange={(checked) => void updateBinding(resource.id, checked === true, order)}
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-xs font-medium">{resource.name}</strong>
                    <small className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {resource.slug} · r{resource.revisionNumber}
                    </small>
                  </span>
                </div>
                {selected && (
                  <form
                    className="mt-2 flex items-end gap-2 border-t border-border pt-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void updateBinding(resource.id, true, Number(data.get("sortOrder")));
                    }}
                  >
                    <Field className="w-24" label="Order">
                      <Input
                        aria-label={`${resource.name} order`}
                        defaultValue={order}
                        key={`${resource.id}-${order}`}
                        min={0}
                        name="sortOrder"
                        type="number"
                      />
                    </Field>
                    <Button size="sm" variant="outline" disabled={pendingResourceId !== undefined} type="submit">
                      Save order
                    </Button>
                  </form>
                )}
              </article>
            );
          })}
          {matches.length === 0 && <p className="py-2 text-xs text-muted-foreground">No {kind}s available.</p>}
        </div>
      </section>
    );
  };

  return (
    <Card className="flex max-h-56 min-h-0 shrink-0 flex-col overflow-hidden">
      <CardHeader className="flex-row items-center justify-between py-2">
        <div>
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            Agent resources
          </p>
          <CardTitle>Instructions &amp; skills</CardTitle>
        </div>
        <Badge variant="outline" className="font-mono">{agentId}</Badge>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-hidden py-2">
        {resources.isPending && <Loading label="Loading resources…" />}
        {resources.error && <ErrorNotice error={resources.error} />}
        {error !== undefined && <ErrorNotice error={error} />}
        <div className="grid h-full min-h-0 gap-4 md:grid-cols-2">
          {renderResources("instruction")}
          {renderResources("skill")}
        </div>
      </CardContent>
    </Card>
  );
}

export function ConfigEditorPage() {
  const { configSetId, agentId } = useParams<"configSetId" | "agentId">();
  const queryClient = useQueryClient();
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [creatingFile, setCreatingFile] = useState(false);
  const creatingFileRef = useRef(false);
  if (!configSetId) throw new Error("Configuration set id is missing.");
  const parsedAgent = AgentId.safeParse(agentId);
  const routeAgentId = parsedAgent.success ? parsedAgent.data : undefined;
  const detail = useQuery({
    queryKey: ["config-set", configSetId],
    queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail),
  });
  const adapters = useQuery({ queryKey: ["adapters"], queryFn: () => api("/api/v1/adapters", AdapterList) });
  const files = useMemo(
    () => routeAgentId
      ? detail.data?.files.filter((file) => file.agentId === routeAgentId) ?? []
      : [],
    [detail.data?.files, routeAgentId],
  );
  useEffect(() => {
    if (files.length === 0) {
      if (selectedFileId !== undefined) setSelectedFileId(undefined);
      return;
    }
    if (!files.some(({ id }) => id === selectedFileId)) setSelectedFileId(files[0]!.id);
  }, [files, selectedFileId]);
  const selected = files.find(({ id }) => id === selectedFileId);
  const adapter = adapters.data?.find(({ id }) => id === routeAgentId);

  const createFile = async (relativePath: string, source: Blob, mediaType: string) => {
    if (!detail.data || !adapter || !routeAgentId || creatingFileRef.current) return;
    creatingFileRef.current = true;
    setCreatingFile(true);
    try {
      setActionError(undefined);
      const target = targetForPath(adapter, relativePath.trim());
      if (files.some((file) => targetKey(file) === targetKey(target))) {
        throw new Error(`${target.root}/${target.relativePath} already exists for ${routeAgentId}.`);
      }
      const descriptor = await uploadBlob(source, mediaType);
      await mutate(
        `/api/v1/config-sets/${configSetId}/configs/${routeAgentId}/files`,
        RevisionResult,
        {
          target,
          blobSha256: descriptor.sha256,
          mediaType,
          utf8: descriptor.monacoEligible,
          executable: false,
        },
        { revision: detail.data.configSet.draftRevision },
      );
      setAdding(false);
      const refreshed = await api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail);
      queryClient.setQueryData(["config-set", configSetId], refreshed);
      setSelectedFileId(refreshed.files.find((candidate) => (
        candidate.agentId === routeAgentId && targetKey(candidate) === targetKey(target)
      ))?.id);
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "REVISION_CONFLICT") {
        await queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] });
      }
      setActionError(cause);
    } finally {
      creatingFileRef.current = false;
      setCreatingFile(false);
    }
  };

  const addFile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const relativePath = String(form.get("relativePath")).trim();
    const mediaType = mediaTypeFor(relativePath);
    void createFile(
      relativePath,
      new Blob([newFileText(relativePath)], { type: mediaType }),
      mediaType,
    );
  };

  const removeSelected = async () => {
    if (!selected || !detail.data) return;
    try {
      await mutate(
        `/api/v1/config-sets/${configSetId}/files`,
        RevisionResult,
        { agentId: selected.agentId, target: { root: selected.root, relativePath: selected.relativePath } },
        { method: "DELETE", revision: detail.data.configSet.draftRevision },
      );
      setSelectedFileId(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (cause) {
      setActionError(cause);
    }
  };

  if (!parsedAgent.success) {
    return <Empty title="Invalid Agent configuration." hint="Choose a valid Agent configuration link." />;
  }
  if (detail.isPending || adapters.isPending) return <Loading label="Loading editor…" />;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (adapters.error) return <ErrorNotice error={adapters.error} />;
  if (!detail.data) return null;
  if (!detail.data.configSet.enabledAgents.includes(parsedAgent.data)) {
    return (
      <Empty
        title="This Agent configuration does not exist in the selected configuration group."
        hint="Create it from the configurations page first."
      />
    );
  }
  if (!adapter) return <ErrorNotice error={new Error(`Adapter ${parsedAgent.data} is unavailable.`)} />;

  return (
    <Page
      fill
      title={detail.data.configSet.name}
      actions={(
        <>
          <Button variant="outline" disabled={creatingFile} onClick={() => setAdding((value) => !value)}>
            <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
            New
          </Button>
          <label
            aria-disabled={creatingFile}
            className={cn(
              buttonVariants({ variant: "outline" }),
              creatingFile && "pointer-events-none opacity-50",
            )}
          >
            <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
            Upload
            <input
              aria-label="Upload file"
              className="sr-only"
              type="file"
              disabled={creatingFile}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                void createFile(
                  file.name,
                  file,
                  file.type || uploadedMediaTypeFor(file.name),
                ).finally(() => {
                  input.value = "";
                });
              }}
            />
          </label>
          <Button
            variant="destructive"
            disabled={!selected || creatingFile}
            onClick={() => void removeSelected()}
          >
            <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />
            Delete
          </Button>
        </>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {adding && (
          <form className="add-file-bar flex shrink-0 items-end gap-2" onSubmit={addFile}>
            <Field className="min-w-0 flex-1" label="Relative path">
              <Input disabled={creatingFile} name="relativePath" placeholder="settings.json" required />
            </Field>
            <Button disabled={creatingFile} type="submit">
              Create
            </Button>
          </form>
        )}
        {actionError !== undefined && <ErrorNotice error={actionError} />}
        <ConfigResourceBindings
          agentId={parsedAgent.data}
          configSetId={configSetId}
          detail={detail.data}
        />
        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr] gap-4 overflow-hidden">
          <Card className="min-h-0 overflow-y-auto p-2">
            <div className="space-y-1">
              {files.map((file) => {
                const FileIcon = file.utf8 ? FileCode : Database;
                const active = file.id === selectedFileId;
                return (
                  <Button
                    className={cn(
                      "relative h-auto w-full justify-start overflow-hidden px-2 py-2 text-left",
                      active && "bg-accent text-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
                    )}
                    key={file.id}
                    onClick={() => setSelectedFileId(file.id)}
                    variant="ghost"
                  >
                    <FileIcon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span className="min-w-0">
                      <strong className="block truncate text-xs font-medium">
                        {file.relativePath.split("/").at(-1)}
                      </strong>
                      <small className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {file.root}/{file.relativePath}
                      </small>
                    </span>
                  </Button>
                );
              })}
              {files.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">No native files yet.</p>
              )}
            </div>
          </Card>
          <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            {!selected && (
              <div className="flex h-full items-center justify-center p-4">
                <Empty
                  title="Select or create a file"
                  hint="Each file keeps an independent Monaco model and undo history."
                />
              </div>
            )}
            {selected && selected.utf8 && selected.size <= MONACO_LIMIT && (
              <TextFileEditor
                key={selected.id}
                configSetId={configSetId}
                initialRevision={detail.data.configSet.draftRevision}
                file={selected}
                adapter={adapter}
              />
            )}
            {selected && (!selected.utf8 || selected.size > MONACO_LIMIT) && (
              <BinaryFilePanel
                configSetId={configSetId}
                revision={detail.data.configSet.draftRevision}
                file={selected}
              />
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

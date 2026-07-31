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
import { AnimatePresence, motion } from "motion/react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { z } from "zod";

import { AgentId, type Diagnostic, type TargetRootId } from "@agent-config-hub/protocol";

import {
  AdapterList,
  ApiClientError,
  ConfigSetDetail,
  ValidationResult,
  api,
  downloadBlob,
  mutate,
  uploadBlob,
  type AdapterMetadata,
  type DraftFile,
  targetKey,
} from "../api.js";
import { ErrorNotice } from "../auth.js";
import { AutosaveCoordinator, type AutosaveState } from "../autosave.js";
import { useAppStatus } from "../shell.js";
import { Empty, Field, Loading } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

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
    instance.editor.defineTheme("ach-void", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "3d4d47" },
        { token: "string", foreground: "b8f35b" },
        { token: "number", foreground: "ffc76b" },
        { token: "keyword", foreground: "3ddcff" },
        { token: "type", foreground: "3ddcff" },
        { token: "key", foreground: "e9efe9" },
      ],
      colors: {
        "editor.background": "#080b0e",
        "editor.foreground": "#e9efe9",
        "editorLineNumber.foreground": "#2b3a36",
        "editorLineNumber.activeForeground": "#b8f35b",
        "editor.lineHighlightBackground": "#0d1114",
        "editorCursor.foreground": "#b8f35b",
        "editor.selectionBackground": "#1d2f1c",
        "editorIndentGuide.background1": "#151c1a",
        "editorWidget.background": "#0d1114",
        "editorWidget.border": "#1e2a27",
      },
    });
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

  if (source.isPending) return <Loading label="Loading file…" />;
  if (source.error) return <ErrorNotice error={source.error} />;

  const saveStateIcon = saveState === "saved"
    ? <Check size={15} strokeWidth={1.5} aria-hidden="true" />
    : saveState === "saving"
      ? <LoaderCircle className="spin" size={15} strokeWidth={1.5} aria-hidden="true" />
      : saveState === "unsaved"
        ? <Dot size={15} strokeWidth={1.5} aria-hidden="true" />
        : <GitMerge size={15} strokeWidth={1.5} aria-hidden="true" />;

  return (
    <div className="editor-stack">
      <div className="editor-toolbar">
        {saveStateIcon}
        <span className={`save-state ${saveState}`}>{saveState}</span>
        <span className="mono">{modelUri}</span>
      </div>
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
        theme="ach-void"
        options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, wordWrap: "on", automaticLayout: true }}
      />
      <DiagnosticsPanel diagnostics={diagnostics} />
      {saveState === "conflict" && (
        <div className="conflict-panel" role="alert">
          <div>
            <strong>Revision conflict</strong>
            <p>Your model is preserved. Compare it with the current server value.</p>
          </div>
          <div className="conflict-columns">
            <div>
              <p className="eyebrow">LOCAL MODEL</p>
              <pre>{text}</pre>
            </div>
            <div>
              <p className="eyebrow">SERVER VALUE</p>
              <pre>{serverConflictText}</pre>
            </div>
          </div>
          <div className="button-row">
            <button className="btn" onClick={() => void navigator.clipboard.writeText(text)}>
              <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
              Copy local
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                const serverText = serverConflictText ?? "";
                savedText.current = serverText;
                setText(serverText);
                coordinator.resolveConflict(serverText);
                setServerConflictText(null);
              }}
            >
              <RotateCcw size={15} strokeWidth={1.5} aria-hidden="true" />
              Reload server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <section className="diagnostics">
      <header>
        <strong>Diagnostics</strong>
        <span>{diagnostics.length}</span>
      </header>
      {diagnostics.length === 0
        ? <p className="muted">No issues detected.</p>
        : (
          <AnimatePresence initial={false}>
            {diagnostics.map((diagnostic, index) => {
              const Icon = diagnostic.severity === "error"
                ? CircleAlert
                : diagnostic.severity === "warning"
                  ? TriangleAlert
                  : Info;
              const borderColor = diagnostic.severity === "error"
                ? "var(--danger)"
                : diagnostic.severity === "warning"
                  ? "var(--warn)"
                  : "var(--volt)";
              return (
                <motion.div
                  className={`diagnostic ${diagnostic.severity}`}
                  key={`${diagnostic.code}-${index}`}
                  style={{ borderLeftColor: borderColor }}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
                  <code>{diagnostic.code}</code>
                  <p>{diagnostic.message}</p>
                </motion.div>
              );
            })}
          </AnimatePresence>
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
    <div className="binary-panel panel">
      <p className="eyebrow">Binary asset</p>
      <h2>{file.relativePath}</h2>
      <dl className="mono">
        <dt>MIME</dt>
        <dd>{file.mediaType}</dd>
        <dt>Size</dt>
        <dd>{file.size.toLocaleString()} bytes</dd>
        <dt>SHA-256</dt>
        <dd className="break">{file.blobSha256}</dd>
      </dl>
      {error !== undefined && <ErrorNotice error={error} />}
      <div className="button-row">
        <a
          className="btn"
          href={`/api/v1/blobs/${file.blobSha256}`}
          download={file.relativePath.split("/").at(-1)}
        >
          <Download size={15} strokeWidth={1.5} aria-hidden="true" />
          Download
        </a>
        <label className="btn">
          <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
          Replace
          <input
            className="visually-hidden"
            type="file"
            onChange={(event) => {
              const replacement = event.target.files?.[0];
              if (replacement) void replace(replacement);
            }}
          />
        </label>
      </div>
    </div>
  );
}

export function ConfigEditorPage() {
  const { configSetId, agentId } = useParams<"configSetId" | "agentId">();
  const queryClient = useQueryClient();
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
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
    if (!detail.data || !adapter || !routeAgentId) return;
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
      index="02"
      eyebrow={`${detail.data.configSet.slug} · ${parsedAgent.data}`}
      title={detail.data.configSet.name}
      actions={(
        <>
          <button className="btn" onClick={() => setAdding((value) => !value)}>
            <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
            New
          </button>
          <label className="btn">
            <Upload size={15} strokeWidth={1.5} aria-hidden="true" />
            Upload
            <input
              aria-label="Upload file"
              className="visually-hidden"
              type="file"
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
          <button
            className="btn btn-danger"
            disabled={!selected}
            onClick={() => void removeSelected()}
          >
            <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />
            Delete
          </button>
        </>
      )}
    >
      {adding && (
        <form className="add-file-bar" onSubmit={addFile}>
          <div className="grow">
            <Field label="Relative path">
              <input name="relativePath" placeholder="settings.json" required />
            </Field>
          </div>
          <MagneticButton className="btn btn-primary" type="submit">
            Create
          </MagneticButton>
        </form>
      )}
      {actionError !== undefined && <ErrorNotice error={actionError} />}
      <div className="editor-shell">
        <aside className="file-tree">
          {files.map((file) => {
            const FileIcon = file.utf8 ? FileCode : Database;
            const active = file.id === selectedFileId;
            return (
              <button
                className={active ? "selected" : ""}
                key={file.id}
                onClick={() => setSelectedFileId(file.id)}
              >
                {active && (
                  <motion.span
                    className="file-active"
                    layoutId="file-active"
                    style={{
                      position: "absolute",
                      inset: "0 auto 0 0",
                      width: 2,
                      background: "var(--volt)",
                    }}
                  />
                )}
                <FileIcon size={15} strokeWidth={1.5} aria-hidden="true" />
                <span>
                  <strong>{file.relativePath.split("/").at(-1)}</strong>
                  <small>{file.root}/{file.relativePath}</small>
                </span>
              </button>
            );
          })}
          {files.length === 0 && (
            <p className="muted tree-empty">No native files yet.</p>
          )}
        </aside>
        <main className="editor-main">
          {!selected && (
            <Empty
              title="Select or create a file"
              hint="Each file keeps an independent Monaco model and undo history."
            />
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
        </main>
      </div>
    </Page>
  );
}

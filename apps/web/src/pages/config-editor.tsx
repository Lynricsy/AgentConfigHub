import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { z } from "zod";

import type { Diagnostic } from "@agent-config-hub/protocol";

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
} from "../api.js";
import { ErrorNotice } from "../auth.js";
import { AutosaveCoordinator, type AutosaveState } from "../autosave.js";
import { useAppStatus } from "../shell.js";

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

  if (source.isPending) return <div className="center-state"><span className="spinner" />Loading file…</div>;
  if (source.error) return <ErrorNotice error={source.error} />;
  return <div className="editor-stack">
    <div className="editor-toolbar"><span className={`save-state ${saveState}`}>{saveState}</span><span className="mono">{modelUri}</span></div>
    <Editor
      height="calc(100vh - 282px)"
      language={language}
      path={modelUri}
      value={text}
      onChange={(value) => setText(value ?? "")}
      beforeMount={beforeMount}
      onMount={onMount}
      keepCurrentModel
      saveViewState
      theme="vs-dark"
      options={{ minimap: { enabled: false }, fontSize: 13, tabSize: 2, wordWrap: "on", automaticLayout: true }}
    />
    <DiagnosticsPanel diagnostics={diagnostics} />
    {saveState === "conflict" && <div className="conflict-panel" role="alert">
      <div><strong>Revision conflict</strong><p>Your model is preserved. Compare it with the current server value.</p></div>
      <div className="conflict-columns"><pre>{text}</pre><pre>{serverConflictText}</pre></div>
      <div className="button-row">
        <button onClick={() => void navigator.clipboard.writeText(text)}>Copy local</button>
        <button className="danger" onClick={() => {
          const serverText = serverConflictText ?? "";
          savedText.current = serverText;
          setText(serverText);
          coordinator.resolveConflict(serverText);
          setServerConflictText(null);
        }}>Reload server</button>
      </div>
    </div>}
  </div>;
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return <section className="diagnostics-panel">
    <header><strong>Diagnostics</strong><span>{diagnostics.length}</span></header>
    {diagnostics.length === 0 ? <p className="muted">No issues detected.</p> : diagnostics.map((diagnostic, index) => <div className={`diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}-${index}`}>
      <span>{diagnostic.severity}</span><code>{diagnostic.code}</code><p>{diagnostic.message}</p>
    </div>)}
  </section>;
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
      const descriptor = await uploadBlob(replacement);
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
  return <div className="binary-panel panel">
    <p className="eyebrow">Binary asset</p><h2>{file.relativePath}</h2>
    <dl><dt>MIME</dt><dd>{file.mediaType}</dd><dt>Size</dt><dd>{file.size.toLocaleString()} bytes</dd><dt>SHA-256</dt><dd className="mono break">{file.blobSha256}</dd></dl>
    {error !== undefined && <ErrorNotice error={error} />}
    <div className="button-row">
      <a className="button" href={`/api/v1/blobs/${file.blobSha256}`} download={file.relativePath.split("/").at(-1)}>Download</a>
      <label className="button">Replace<input className="visually-hidden" type="file" onChange={(event) => {
        const replacement = event.target.files?.[0];
        if (replacement) void replace(replacement);
      }} /></label>
    </div>
  </div>;
}

export function ConfigEditorPage() {
  const { configSetId } = useParams<"configSetId">();
  const queryClient = useQueryClient();
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [newFileAgent, setNewFileAgent] = useState("");
  const [newFileSurface, setNewFileSurface] = useState(0);
  const [actionError, setActionError] = useState<unknown>();
  if (!configSetId) throw new Error("Configuration set id is missing.");
  const detail = useQuery({
    queryKey: ["config-set", configSetId],
    queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail),
  });
  const adapters = useQuery({ queryKey: ["adapters"], queryFn: () => api("/api/v1/adapters", AdapterList) });
  useEffect(() => {
    if (!selectedFileId && detail.data?.files[0]) setSelectedFileId(detail.data.files[0].id);
  }, [detail.data?.files, selectedFileId]);
  const selected = detail.data?.files.find(({ id }) => id === selectedFileId);
  const adapter = adapters.data?.find(({ id }) => id === selected?.agentId);

  const addFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail.data || !adapters.data) return;
    const form = new FormData(event.currentTarget);
    const agentId = String(form.get("agentId"));
    const adapterMetadata = adapters.data.find(({ id }) => id === agentId);
    const surfaceIndex = Number(form.get("surface"));
    const surface = adapterMetadata?.surfaces.filter(({ reserved }) => !reserved)[surfaceIndex];
    const relativePath = String(form.get("relativePath")).trim();
    if (!adapterMetadata || !surface || !safeRelativePath(relativePath) || !surfaceAllows(surface.pattern, relativePath)) {
      setActionError(new Error("Choose a managed surface and enter a safe relative path."));
      return;
    }
    try {
      const mediaType = mediaTypeFor(relativePath);
      const descriptor = await uploadBlob(new Blob([newFileText(relativePath)], { type: mediaType }));
      await mutate(
        `/api/v1/config-sets/${configSetId}/files`,
        RevisionResult,
        {
          agentId,
          target: { root: surface.root, relativePath },
          blobSha256: descriptor.sha256,
          mediaType,
          utf8: true,
          executable: false,
        },
        { method: "PUT", revision: detail.data.configSet.draftRevision },
      );
      setAdding(false);
      const refreshed = await queryClient.fetchQuery({
        queryKey: ["config-set", configSetId],
        queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail),
      });
      setSelectedFileId(refreshed.files.find((candidate) => (
        candidate.agentId === agentId && candidate.root === surface.root && candidate.relativePath === relativePath
      ))?.id);
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    } catch (cause) {
      setActionError(cause);
    }
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

  if (detail.isPending || adapters.isPending) return <div className="center-state"><span className="spinner" />Loading editor…</div>;
  if (detail.error) return <ErrorNotice error={detail.error} />;
  if (adapters.error) return <ErrorNotice error={adapters.error} />;
  if (!detail.data) return null;
  const filesByAgent = Map.groupBy(detail.data.files, ({ agentId }) => agentId);

  return <div className="editor-page">
    <header className="editor-head">
      <div><p className="eyebrow">{detail.data.configSet.slug}</p><h1>{detail.data.configSet.name}</h1></div>
      <div className="button-row"><button onClick={() => setAdding((value) => !value)}>Add file</button><button className="danger" disabled={!selected} onClick={() => void removeSelected()}>Delete</button></div>
    </header>
    {adding && <form className="add-file-bar" onSubmit={(event) => void addFile(event)}>
      <label>Agent<select name="agentId" required value={newFileAgent || detail.data.configSet.enabledAgents[0]} onChange={(event) => { setNewFileAgent(event.target.value); setNewFileSurface(0); }}>{detail.data.configSet.enabledAgents.map((agentId) => <option key={agentId}>{agentId}</option>)}</select></label>
      <label>Managed surface<select name="surface" required value={newFileSurface} onChange={(event) => setNewFileSurface(Number(event.target.value))}>{adapters.data?.find(({ id }) => id === (newFileAgent || detail.data.configSet.enabledAgents[0]))?.surfaces.filter(({ reserved }) => !reserved).map((surface, index) => <option key={`${surface.root}-${surface.pattern}`} value={index}>{surface.root} · {surface.pattern}</option>)}</select></label>
      <label className="grow">Relative path<input name="relativePath" placeholder="settings.json" required /></label>
      <button className="primary">Create</button>
    </form>}
    {actionError !== undefined && <ErrorNotice error={actionError} />}
    <div className="editor-grid">
      <aside className="file-tree">
        <div className="tree-title"><span>Managed files</span><span>{detail.data.files.length}</span></div>
        {[...filesByAgent.entries()].map(([agentId, files]) => <section key={agentId}>
          <h3>{agentId}</h3>
          {files.map((file) => <button className={file.id === selectedFileId ? "selected" : ""} key={file.id} onClick={() => setSelectedFileId(file.id)}>
            <span className="file-kind">{file.utf8 ? "TXT" : "BIN"}</span>
            <span><strong>{file.relativePath.split("/").at(-1)}</strong><small>{file.root}/{file.relativePath}</small></span>
          </button>)}
        </section>)}
        {detail.data.files.length === 0 && <p className="muted tree-empty">No native files yet.</p>}
      </aside>
      <main className="editor-main">
        {!selected && <div className="empty-state"><strong>Select or create a file</strong><p>Each file keeps an independent Monaco model and undo history.</p></div>}
        {selected && selected.utf8 && selected.size <= MONACO_LIMIT && adapter && <TextFileEditor key={selected.id} configSetId={configSetId} initialRevision={detail.data.configSet.draftRevision} file={selected} adapter={adapter} />}
        {selected && (!selected.utf8 || selected.size > MONACO_LIMIT) && <BinaryFilePanel configSetId={configSetId} revision={detail.data.configSet.draftRevision} file={selected} />}
      </main>
    </div>
  </div>;
}

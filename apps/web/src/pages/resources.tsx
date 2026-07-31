import Editor, { type Monaco } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode, FileText, LoaderCircle, Package, Plus, Save, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import {
  ResourceList,
  ApiClientError,
  api,
  downloadBlob,
  mutate,
  uploadBlob,
  type ResourceList as ResourceData,
} from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Chip, Empty, Field, Loading } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const ResourceCreated = z.object({ id: z.string(), revisionId: z.string() });
const ResourceRevised = z.object({ revisionId: z.string() });

type Resource = ResourceData["resources"][number];
type ResourceFile = ResourceData["files"][number];

function languageFor(path: string): string {
  const lower = path.toLocaleLowerCase("en-US");
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".md") || lower.endsWith(".mdc")) return "markdown";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "shell";
  if (lower.endsWith(".py")) return "python";
  return "plaintext";
}

function mediaTypeFor(path: string): string {
  const language = languageFor(path);
  if (language === "json") return "application/json";
  if (language === "yaml") return "application/yaml";
  if (language === "toml") return "application/toml";
  if (language === "markdown") return "text/markdown";
  if (["typescript", "javascript", "shell", "python", "plaintext"].includes(language)) return "text/plain";
  return "application/octet-stream";
}

function initialText(kind: Resource["kind"], name: string, slug: string, path: string): string {
  if (kind === "instruction") return `# ${name}\n`;
  if (path === "SKILL.md") return `---\nname: ${slug}\ndescription: ${name}\n---\n\n`;
  if (languageFor(path) === "json") return "{}\n";
  return "";
}

function isInlineEditable(file: ResourceFile): boolean {
  return file.mediaType.startsWith("text/") ||
    ["application/json", "application/yaml", "application/toml"].includes(file.mediaType) ||
    languageFor(file.relativePath) !== "plaintext";
}

function defineResourceTheme(monaco: Monaco): void {
  monaco.editor.defineTheme("ach-void", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "3d4d47" },
      { token: "string", foreground: "b8f35b" },
      { token: "number", foreground: "ffc76b" },
      { token: "keyword", foreground: "3ddcff" },
      { token: "type", foreground: "3ddcff" },
    ],
    colors: {
      "editor.background": "#080b0e",
      "editor.foreground": "#e9efe9",
      "editorLineNumber.foreground": "#2b3a36",
      "editorLineNumber.activeForeground": "#b8f35b",
      "editor.lineHighlightBackground": "#0d1114",
      "editorCursor.foreground": "#b8f35b",
      "editor.selectionBackground": "#1d2f1c",
    },
  });
}

function ResourceFileEditor({
  resource,
  file,
  files,
}: {
  resource: Resource;
  file: ResourceFile;
  files: ResourceFile[];
}) {
  const queryClient = useQueryClient();
  const source = useQuery({
    queryKey: ["blob-text", file.blobSha256],
    queryFn: async () => await (await downloadBlob(file.blobSha256)).text(),
    enabled: isInlineEditable(file),
  });
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<{
    resource: Resource;
    files: ResourceFile[];
    serverText: string;
    latest: ResourceData;
  }>();
  useEffect(() => {
    if (source.data === undefined) return;
    setText(source.data);
    setSavedText(source.data);
  }, [source.data]);
  const save = async (
    baseResource: Resource = resource,
    baseFiles: ResourceFile[] = files,
  ) => {
    if (text === savedText && conflict === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const descriptor = await uploadBlob(new Blob([text], { type: file.mediaType }), file.mediaType);
      const nextFiles = baseFiles.map((candidate) => ({
        relativePath: candidate.relativePath,
        blobSha256: candidate.relativePath === file.relativePath
          ? descriptor.sha256
          : candidate.blobSha256,
        mediaType: candidate.mediaType,
        executable: candidate.executable,
      }));
      if (!baseFiles.some((candidate) => candidate.relativePath === file.relativePath)) {
        nextFiles.push({
          relativePath: file.relativePath,
          blobSha256: descriptor.sha256,
          mediaType: file.mediaType,
          executable: file.executable,
        });
      }
      await mutate(
        `/api/v1/resources/${baseResource.id}`,
        ResourceRevised,
        { files: nextFiles },
        { method: "PUT", revision: baseResource.revisionId },
      );
      setSavedText(text);
      setConflict(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
        queryClient.invalidateQueries({ queryKey: ["config-set"] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "REVISION_CONFLICT") {
        try {
          const latest = await api("/api/v1/resources", ResourceList);
          const latestResource = latest.resources.find((candidate) => candidate.id === resource.id);
          if (latestResource === undefined) throw cause;
          const latestFiles = latest.files.filter((candidate) => candidate.resourceId === resource.id);
          const latestFile = latestFiles.find((candidate) => candidate.relativePath === file.relativePath);
          const serverText = latestFile === undefined
            ? ""
            : await (await downloadBlob(latestFile.blobSha256)).text();
          setConflict({ resource: latestResource, files: latestFiles, serverText, latest });
          setError(undefined);
        } catch (refreshError) {
          setError(refreshError);
        }
      } else {
        setError(cause);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isInlineEditable(file)) {
    return (
      <Empty
        title="Binary file"
        hint="This resource keeps the file, but binary content cannot be edited inline."
      />
    );
  }
  if (source.isPending) return <Loading label="Loading resource file…" />;
  if (source.error) return <ErrorNotice error={source.error} />;

  return (
    <div className="resource-editor">
      <div className="editor-toolbar">
        {saving ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <FileCode size={15} aria-hidden="true" />}
        <span className="mono">{file.relativePath}</span>
        <span className={text === savedText ? "save-state saved" : "save-state unsaved"}>
          {text === savedText ? "saved" : "edited"}
        </span>
        <button className="btn" disabled={saving || text === savedText} onClick={() => void save()}>
          <Save size={15} aria-hidden="true" />
          Save revision
        </button>
      </div>
      {error !== undefined && <ErrorNotice error={error} />}
      {conflict !== undefined && (
        <section className="conflict-panel" role="alert">
          <h3>Resource revision changed</h3>
          <p>Another editor saved this resource. Your draft is preserved; compare before choosing a version.</p>
          <div className="conflict-columns">
            <div>
              <strong>Your draft</strong>
              <pre>{text}</pre>
            </div>
            <div>
              <strong>Latest server revision</strong>
              <pre>{conflict.serverText}</pre>
            </div>
          </div>
          <div className="button-row">
            <button
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void save(conflict.resource, conflict.files)}
              type="button"
            >
              Keep mine as new revision
            </button>
            <button
              className="btn"
              disabled={saving}
              onClick={() => {
                queryClient.setQueryData(["resources"], conflict.latest);
                setConflict(undefined);
              }}
              type="button"
            >
              Reload server version
            </button>
          </div>
        </section>
      )}
      <Editor
        beforeMount={defineResourceTheme}
        height="min(62vh, 46rem)"
        language={languageFor(file.relativePath)}
        onChange={(value) => setText(value ?? "")}
        options={{
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono Variable', monospace",
          fontSize: 13,
          padding: { top: 14 },
          scrollBeyondLastLine: false,
          wordWrap: file.relativePath.endsWith(".md") ? "on" : "off",
        }}
        path={`resource://${resource.id}/${resource.revisionId}/${file.relativePath}`}
        theme="ach-void"
        value={text}
      />
    </div>
  );
}

export function ResourcesPage() {
  const queryClient = useQueryClient();
  const [creatingKind, setCreatingKind] = useState<Resource["kind"]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [addingFile, setAddingFile] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => api("/api/v1/resources", ResourceList),
  });
  const instructions = resources.data?.resources.filter(({ kind }) => kind === "instruction") ?? [];
  const skills = resources.data?.resources.filter(({ kind }) => kind === "skill") ?? [];
  const selected = resources.data?.resources.find(({ id }) => id === selectedId);
  const selectedFiles = useMemo(
    () => resources.data?.files.filter(({ resourceId }) => resourceId === selectedId) ?? [],
    [resources.data?.files, selectedId],
  );
  const selectedFile = selectedFiles.find(({ relativePath }) => relativePath === selectedPath);

  useEffect(() => {
    if (selected && selectedFiles.length > 0 && !selectedFile) {
      setSelectedPath(
        selectedFiles.find(({ relativePath }) => relativePath === "SKILL.md")?.relativePath ??
          selectedFiles[0]!.relativePath,
      );
    }
  }, [selected, selectedFile, selectedFiles]);

  const selectResource = (resource: Resource, path?: string) => {
    setSelectedId(resource.id);
    const files = resources.data?.files.filter(({ resourceId }) => resourceId === resource.id) ?? [];
    setSelectedPath(path ?? files.find(({ relativePath }) => relativePath === "SKILL.md")?.relativePath ?? files[0]?.relativePath);
    setAddingFile(false);
    setActionError(undefined);
  };

  const createResource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!creatingKind) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const slug = String(form.get("slug")).trim();
    const relativePath = creatingKind === "instruction" ? "instruction.md" : "SKILL.md";
    setPending(true);
    setActionError(undefined);
    try {
      const mediaType = "text/markdown";
      const descriptor = await uploadBlob(
        new Blob([initialText(creatingKind, name, slug, relativePath)], { type: mediaType }),
        mediaType,
      );
      const created = await mutate(
        "/api/v1/resources",
        ResourceCreated,
        {
          kind: creatingKind,
          slug,
          name,
          files: [{
            relativePath,
            blobSha256: descriptor.sha256,
            mediaType,
            executable: false,
          }],
        },
      );
      const refreshed = await api("/api/v1/resources", ResourceList);
      queryClient.setQueryData(["resources"], refreshed);
      setSelectedId(created.data.id);
      setSelectedPath(relativePath);
      setCreatingKind(undefined);
    } catch (cause) {
      setActionError(cause);
    } finally {
      setPending(false);
    }
  };

  const saveFileTree = async (
    resource: Resource,
    files: Array<Pick<ResourceFile, "relativePath" | "blobSha256" | "mediaType" | "executable">>,
  ): Promise<boolean> => {
    setPending(true);
    setActionError(undefined);
    try {
      await mutate(
        `/api/v1/resources/${resource.id}`,
        ResourceRevised,
        { files },
        { method: "PUT", revision: resource.revisionId },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
        queryClient.invalidateQueries({ queryKey: ["config-set"] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
      return true;
    } catch (cause) {
      setActionError(cause);
      return false;
    } finally {
      setPending(false);
    }
  };

  const addSkillFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || selected.kind !== "skill") return;
    const form = new FormData(event.currentTarget);
    const relativePath = String(form.get("relativePath")).trim();
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") ||
      relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      setActionError(new Error("Enter a safe, non-empty relative path."));
      return;
    }
    if (selectedFiles.some((file) => file.relativePath === relativePath)) {
      setActionError(new Error(`${relativePath} already exists in this skill.`));
      return;
    }
    try {
      const mediaType = mediaTypeFor(relativePath);
      const descriptor = await uploadBlob(
        new Blob([initialText("skill", selected.name, selected.slug, relativePath)], { type: mediaType }),
        mediaType,
      );
      const saved = await saveFileTree(selected, [
        ...selectedFiles.map(({ relativePath: path, blobSha256, mediaType: type, executable }) => ({
          relativePath: path,
          blobSha256,
          mediaType: type,
          executable,
        })),
        {
          relativePath,
          blobSha256: descriptor.sha256,
          mediaType,
          executable: false,
        },
      ]);
      if (saved) {
        setSelectedPath(relativePath);
        setAddingFile(false);
      }
    } catch (cause) {
      setActionError(cause);
    }
  };

  const deleteSelectedFile = async () => {
    if (!selected || selected.kind !== "skill" || !selectedFile || selectedFile.relativePath === "SKILL.md") return;
    const saved = await saveFileTree(
      selected,
      selectedFiles
        .filter(({ relativePath }) => relativePath !== selectedFile.relativePath)
        .map(({ relativePath, blobSha256, mediaType, executable }) => ({
          relativePath,
          blobSha256,
          mediaType,
          executable,
        })),
    );
    if (saved) setSelectedPath("SKILL.md");
  };

  if (resources.isPending) return <Loading label="Loading resources…" />;

  return (
    <Page
      index="03"
      eyebrow="Shared library"
      title="Resources"
      lede="Edit reusable instructions and skill files directly. Bind them from each Agent configuration."
      actions={(
        <>
          <MagneticButton
            className="btn"
            onClick={() => setCreatingKind((kind) => kind === "instruction" ? undefined : "instruction")}
            type="button"
          >
            <FileText size={15} aria-hidden="true" />
            New instruction
          </MagneticButton>
          <MagneticButton
            className="btn btn-primary"
            onClick={() => setCreatingKind((kind) => kind === "skill" ? undefined : "skill")}
            type="button"
          >
            <Package size={15} aria-hidden="true" />
            New skill
          </MagneticButton>
        </>
      )}
    >
      {creatingKind && (
        <form className="panel resource-form" onSubmit={(event) => void createResource(event)}>
          <p className="eyebrow">New {creatingKind}</p>
          <div className="form-row">
            <Field label="Name">
              <input name="name" required />
            </Field>
            <Field label="Slug">
              <input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
            </Field>
          </div>
          {actionError !== undefined && <ErrorNotice error={actionError} />}
          <MagneticButton className="btn btn-primary" disabled={pending} type="submit">
            Create {creatingKind}
          </MagneticButton>
        </form>
      )}

      {resources.error && <ErrorNotice error={resources.error} />}
      <div className="resource-workspace">
        <aside className="resource-browser">
          <section aria-labelledby="instruction-heading">
            <h2 id="instruction-heading">Instructions</h2>
            {instructions.map((resource) => (
              <button
                className={selectedId === resource.id ? "selected" : ""}
                key={resource.id}
                onClick={() => selectResource(resource, "instruction.md")}
                type="button"
              >
                <FileText size={15} aria-hidden="true" />
                <span>
                  <strong>{resource.name}</strong>
                  <small>{resource.slug} · r{resource.revisionNumber}</small>
                </span>
              </button>
            ))}
            {instructions.length === 0 && <p className="muted resource-empty">No instructions.</p>}
          </section>

          <section aria-labelledby="skill-heading">
            <h2 id="skill-heading">Skills</h2>
            {skills.map((resource) => {
              const files = resources.data?.files.filter(({ resourceId }) => resourceId === resource.id) ?? [];
              return (
                <div className="resource-tree" key={resource.id}>
                  <button
                    className={selectedId === resource.id && !selectedPath ? "selected" : ""}
                    onClick={() => selectResource(resource)}
                    type="button"
                  >
                    <Package size={15} aria-hidden="true" />
                    <span>
                      <strong>{resource.name}</strong>
                      <small>{resource.slug} · r{resource.revisionNumber}</small>
                    </span>
                  </button>
                  <div className="resource-tree-files">
                    {files.map((file) => (
                      <button
                        className={selectedId === resource.id && selectedPath === file.relativePath ? "selected" : ""}
                        key={file.relativePath}
                        onClick={() => selectResource(resource, file.relativePath)}
                        type="button"
                      >
                        <FileCode size={14} aria-hidden="true" />
                        <span>{file.relativePath}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {skills.length === 0 && <p className="muted resource-empty">No skills.</p>}
          </section>
        </aside>

        <main className="resource-detail">
          {!selected || !selectedFile
            ? <Empty title="Select a resource file" hint="The file opens here for direct editing." />
            : (
                <>
                  <header className="resource-editor-header">
                    <div>
                      <Chip>{selected.kind}</Chip>
                      <h2 className="display-sm">{selected.name}</h2>
                      <p className="mono">{selected.slug} · revision {selected.revisionNumber}</p>
                    </div>
                    {selected.kind === "skill" && (
                      <div className="button-row">
                        <button className="btn" onClick={() => setAddingFile((value) => !value)}>
                          <Plus size={15} aria-hidden="true" />
                          New file
                        </button>
                        <button
                          className="btn btn-danger"
                          disabled={selectedFile.relativePath === "SKILL.md" || pending}
                          onClick={() => void deleteSelectedFile()}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                          Delete file
                        </button>
                      </div>
                    )}
                  </header>
                  {addingFile && selected.kind === "skill" && (
                    <form className="add-file-bar" onSubmit={(event) => void addSkillFile(event)}>
                      <div className="grow">
                        <Field label="Relative path">
                          <input name="relativePath" placeholder="scripts/check.ts" required />
                        </Field>
                      </div>
                      <button className="btn btn-primary" disabled={pending} type="submit">Create file</button>
                    </form>
                  )}
                  {actionError !== undefined && <ErrorNotice error={actionError} />}
                  <ResourceFileEditor
                    key={`${selected.revisionId}-${selectedFile.relativePath}`}
                    resource={selected}
                    file={selectedFile}
                    files={selectedFiles}
                  />
                </>
              )}
        </main>
      </div>
    </Page>
  );
}

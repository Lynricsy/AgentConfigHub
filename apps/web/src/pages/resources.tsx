import Editor from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode, FileText, LoaderCircle, Package, Plus, Save, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { defineMonacoThemes, monacoThemeFor } from "../monaco-theme.js";
import { useTheme } from "../theme.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader } from "../ui/card.js";
import { Empty } from "../ui/empty.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import { Loading } from "../ui/spinner.js";

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
  const { resolved } = useTheme();
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
      toast.success("Revision saved");
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
          toast.error("Revision changed on the server");
          setError(undefined);
        } catch (refreshError) {
          setError(refreshError);
          toast.error("Could not save revision");
        }
      } else {
        setError(cause);
        toast.error("Could not save revision");
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {saving
          ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          : <FileCode className="size-4 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.relativePath}</span>
        <span
          className={
            text === savedText
              ? "save-state rounded-full bg-success/10 px-2 py-0.5 text-[0.6875rem] font-medium text-success"
              : "save-state rounded-full bg-warning/10 px-2 py-0.5 text-[0.6875rem] font-medium text-warning"
          }
        >
          {text === savedText ? "saved" : "edited"}
        </span>
        <Button
          disabled={saving || text === savedText}
          onClick={() => void save()}
          size="sm"
          variant="outline"
        >
          <Save aria-hidden="true" />
          Save revision
        </Button>
      </div>
      {error !== undefined && <div className="shrink-0 p-3"><ErrorNotice error={error} /></div>}
      {conflict !== undefined && (
        <section
          className="conflict-panel m-3 max-h-80 shrink-0 overflow-y-auto rounded-md border border-warning/40 bg-warning/5 p-4"
          role="alert"
        >
          <h3 className="text-sm font-semibold">Resource revision changed</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Another editor saved this resource. Your draft is preserved; compare before choosing a version.
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="min-w-0">
              <strong className="text-xs font-medium">Your draft</strong>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">{text}</pre>
            </div>
            <div className="min-w-0">
              <strong className="text-xs font-medium">Latest server revision</strong>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">
                {conflict.serverText}
              </pre>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={saving}
              onClick={() => void save(conflict.resource, conflict.files)}
              size="sm"
            >
              Keep mine as new revision
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                queryClient.setQueryData(["resources"], conflict.latest);
                setConflict(undefined);
              }}
              size="sm"
              variant="outline"
            >
              Reload server version
            </Button>
          </div>
        </section>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Editor
          beforeMount={defineMonacoThemes}
          height="100%"
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
          theme={monacoThemeFor(resolved)}
          value={text}
        />
      </div>
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
      fill
      title="Resources"
      lede="Edit reusable instructions and skill files directly. Bind them from each Agent configuration."
      actions={(
        <>
          <Button
            onClick={() => setCreatingKind((kind) => kind === "instruction" ? undefined : "instruction")}
            type="button"
            variant="outline"
          >
            <FileText aria-hidden="true" />
            New instruction
          </Button>
          <Button
            onClick={() => setCreatingKind((kind) => kind === "skill" ? undefined : "skill")}
            type="button"
          >
            <Package aria-hidden="true" />
            New skill
          </Button>
        </>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {creatingKind && (
          <Card className="shrink-0">
            <form onSubmit={(event) => void createResource(event)}>
              <CardHeader className="flex-row items-center justify-between">
                <h2 className="text-sm font-semibold">New {creatingKind}</h2>
                <Button disabled={pending} size="sm" type="submit">
                  Create {creatingKind}
                </Button>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <Field label="Name">
                  <Input name="name" required />
                </Field>
                <Field label="Slug">
                  <Input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
                </Field>
                {actionError !== undefined && (
                  <div className="md:col-span-2"><ErrorNotice error={actionError} /></div>
                )}
              </CardContent>
            </form>
          </Card>
        )}

        {resources.error && <div className="shrink-0"><ErrorNotice error={resources.error} /></div>}
        <div className="grid grid-cols-[280px_1fr] gap-4 min-h-0 flex-1 overflow-hidden">
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <CardContent className="min-h-0 flex-1 overflow-y-auto p-2">
              <section aria-labelledby="instruction-heading">
                <h2
                  className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  id="instruction-heading"
                >
                  Instructions
                </h2>
                <div className="flex flex-col gap-1">
                  {instructions.map((resource) => (
                    <button
                      className={
                        selectedId === resource.id
                          ? "flex w-full items-start gap-2 rounded-md bg-accent px-2.5 py-2 text-left text-accent-foreground transition-colors duration-150"
                          : "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-accent/60"
                      }
                      key={resource.id}
                      onClick={() => selectResource(resource, "instruction.md")}
                      type="button"
                    >
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-medium">{resource.name}</strong>
                        <small className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                          {resource.slug} · r{resource.revisionNumber}
                        </small>
                      </span>
                      <Badge className="mt-0.5" variant="outline">instruction</Badge>
                    </button>
                  ))}
                </div>
                {instructions.length === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">No instructions.</p>
                )}
              </section>

              <section className="mt-4" aria-labelledby="skill-heading">
                <h2
                  className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  id="skill-heading"
                >
                  Skills
                </h2>
                <div className="flex flex-col gap-1">
                  {skills.map((resource) => {
                    const files = resources.data?.files.filter(({ resourceId }) => resourceId === resource.id) ?? [];
                    return (
                      <div key={resource.id}>
                        <button
                          className={
                            selectedId === resource.id && !selectedPath
                              ? "flex w-full items-start gap-2 rounded-md bg-accent px-2.5 py-2 text-left text-accent-foreground transition-colors duration-150"
                              : "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-accent/60"
                          }
                          onClick={() => selectResource(resource)}
                          type="button"
                        >
                          <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm font-medium">{resource.name}</strong>
                            <small className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                              {resource.slug} · r{resource.revisionNumber}
                            </small>
                          </span>
                          <Badge className="mt-0.5" variant="outline">skill</Badge>
                        </button>
                        <div className="ml-5 flex flex-col border-l border-border pl-2">
                          {files.map((file) => (
                            <button
                              className={
                                selectedId === resource.id && selectedPath === file.relativePath
                                  ? "flex w-full items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-left text-xs text-accent-foreground transition-colors duration-150"
                                  : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-accent/60"
                              }
                              key={file.relativePath}
                              onClick={() => selectResource(resource, file.relativePath)}
                              type="button"
                            >
                              <FileCode className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <span className="truncate font-mono">{file.relativePath}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {skills.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No skills.</p>}
              </section>
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-col overflow-hidden">
            {!selected || !selectedFile
              ? (
                  <CardContent className="flex min-h-0 flex-1 items-center justify-center">
                    <Empty title="Select a resource file" hint="The file opens here for direct editing." />
                  </CardContent>
                )
              : (
                  <>
                    <CardHeader className="shrink-0 flex-row items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2">
                          <Badge variant="outline">{selected.kind}</Badge>
                          <h2 className="truncate text-sm font-semibold">{selected.name}</h2>
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {selected.slug} · revision {selected.revisionNumber}
                        </p>
                      </div>
                      {selected.kind === "skill" && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            onClick={() => setAddingFile((value) => !value)}
                            size="sm"
                            variant="outline"
                          >
                            <Plus aria-hidden="true" />
                            New file
                          </Button>
                          <Button
                            disabled={selectedFile.relativePath === "SKILL.md" || pending}
                            onClick={() => void deleteSelectedFile()}
                            size="sm"
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" />
                            Delete file
                          </Button>
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
                      {addingFile && selected.kind === "skill" && (
                        <form
                          className="add-file-bar flex shrink-0 items-end gap-2 border-b border-border p-3"
                          onSubmit={(event) => void addSkillFile(event)}
                        >
                          <Field className="min-w-0 flex-1" label="Relative path">
                            <Input name="relativePath" placeholder="scripts/check.ts" required />
                          </Field>
                          <Button disabled={pending} size="sm" type="submit">Create file</Button>
                        </form>
                      )}
                      {actionError !== undefined && (
                        <div className="shrink-0 border-b border-border p-3">
                          <ErrorNotice error={actionError} />
                        </div>
                      )}
                      <ResourceFileEditor
                        key={`${selected.revisionId}-${selectedFile.relativePath}`}
                        resource={selected}
                        file={selectedFile}
                        files={selectedFiles}
                      />
                    </CardContent>
                  </>
                )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

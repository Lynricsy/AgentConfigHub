import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ConfigSetDetail, ConfigSetList, ResourceList, api, mutate, uploadBlob } from "../api.js";
import { ErrorNotice } from "../auth.js";

const ResourceCreated = z.object({ id: z.string(), revisionId: z.string() });
const ResourceRevised = z.object({ revisionId: z.string() });

function DirectoryInput({ name, required = false }: { name: string; required?: boolean }) {
  return <input
    name={name}
    type="file"
    multiple
    required={required}
    ref={(element) => {
      element?.setAttribute("webkitdirectory", "");
    }}
  />;
}
const RevisionResult = z.object({ revision: z.number().int() });

async function uploadFiles(files: File[]) {
  if (files.length === 0) throw new Error("Choose at least one file.");
  const directoryPaths = files.map((file) => file.webkitRelativePath);
  const fromDirectory = directoryPaths.every(Boolean);
  if (!fromDirectory && directoryPaths.some(Boolean)) throw new Error("Directory selection is incomplete.");
  const root = fromDirectory ? directoryPaths[0]!.split("/")[0] : null;
  const paths = files.map((file, index) => {
    const raw = fromDirectory ? directoryPaths[index]! : file.name;
    const segments = raw.split("/");
    if (root !== null && segments.shift() !== root) throw new Error("Every skill file must share one root directory.");
    if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Skill paths must be safe, non-empty relative paths.");
    }
    return segments.join("/");
  });
  if (new Set(paths).size !== paths.length) throw new Error("Skill file paths must be unique.");
  return await Promise.all(files.map(async (file, index) => {
    const blob = await uploadBlob(file);
    return {
      relativePath: paths[index]!,
      blobSha256: blob.sha256,
      mediaType: file.type || "application/octet-stream",
      executable: false,
    };
  }));
}

export function ResourcesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedConfigId, setSelectedConfigId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<"create" | "replace">();
  const [actionError, setActionError] = useState<{ action: "create" | "replace"; error: unknown }>();
  const resources = useQuery({ queryKey: ["resources"], queryFn: () => api("/api/v1/resources", ResourceList) });
  const configSets = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  const selectedConfig = useQuery({
    queryKey: ["config-set", selectedConfigId],
    queryFn: () => api(`/api/v1/config-sets/${selectedConfigId}`, ConfigSetDetail),
    enabled: Boolean(selectedConfigId),
  });
  const createResource = async (input: {
    kind: "instruction" | "skill";
    slug: string;
    name: string;
    files: File[];
    markdown: string;
  }) => {
    setPendingAction("create"); setActionError(undefined);
    try {
      const files = input.kind === "instruction"
        ? await (async () => {
            const descriptor = await uploadBlob(new Blob([input.markdown], { type: "text/markdown" }));
            return [{
              relativePath: "instruction.md",
              blobSha256: descriptor.sha256,
              mediaType: "text/markdown",
              executable: false,
            }];
          })()
        : await uploadFiles(input.files);
      await mutate("/api/v1/resources", ResourceCreated, {
        kind: input.kind, slug: input.slug, name: input.name, files,
      });
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
    } catch (error) { setActionError({ action: "create", error }); }
    finally { setPendingAction(undefined); }
  };
  const replaceResource = async (input: { resourceId: string; revisionId: string; files: File[] }) => {
    setPendingAction("replace"); setActionError(undefined);
    try {
      await mutate(
        `/api/v1/resources/${input.resourceId}`,
        ResourceRevised,
        { files: await uploadFiles(input.files) },
        { method: "PUT", revision: input.revisionId },
      );
      await queryClient.invalidateQueries({ queryKey: ["resources"] });
    } catch (error) { setActionError({ action: "replace", error }); }
    finally { setPendingAction(undefined); }
  };

  const createSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const fileInput = form.elements.namedItem("files");
    const files = fileInput instanceof HTMLInputElement ? [...(fileInput.files ?? [])] : [];
    const input = {
      kind: z.enum(["instruction", "skill"]).parse(data.get("kind")),
      slug: String(data.get("slug")),
      name: String(data.get("name")),
      markdown: String(data.get("markdown")),
      files,
    };
    form.reset();
    void createResource(input);
  };
  const selected = resources.data?.resources.find(({ id }) => id === selectedId);
  const selectedFiles = resources.data?.files.filter(({ resourceId }) => resourceId === selectedId) ?? [];

  const setSelection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !selectedConfig.data) return;
    const data = new FormData(event.currentTarget);
    await mutate(
      `/api/v1/config-sets/${selectedConfig.data.configSet.id}/resources/${selected.id}`,
      RevisionResult,
      { sortOrder: Number(data.get("sortOrder")), selectedAgents: data.getAll("agents").map(String) },
      { method: "PUT", revision: selectedConfig.data.configSet.draftRevision },
    );
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["config-set", selectedConfig.data.configSet.id] }),
      queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
    ]);
  };

  return <div className="page-frame">
    <header className="page-header"><div><p className="eyebrow">Shared library</p><h1>Resources</h1><p>Ordered instructions and portable skill file trees, revisioned independently.</p></div><button className="primary" onClick={() => setCreating((value) => !value)}>{creating ? "Cancel" : "New resource"}</button></header>
    {creating && <form className="panel resource-form" onSubmit={createSubmit}>
      <div className="form-row"><label>Kind<select name="kind"><option value="instruction">Instruction</option><option value="skill">Skill</option></select></label><label>Name<input name="name" required /></label><label>Slug<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /></label></div>
      <label>Instruction Markdown<textarea name="markdown" rows={5} placeholder="Used for instruction resources; ignored for skills." /></label>
      <label>Skill directory<DirectoryInput name="files" /></label>
      {actionError?.action === "create" && <ErrorNotice error={actionError.error} />}<button className="primary" disabled={pendingAction === "create"}>Create revision</button>
    </form>}
    <div className="split-view">
      <section className="resource-list panel">
        {resources.data?.resources.map((resource) => <button key={resource.id} className={selectedId === resource.id ? "selected" : ""} onClick={() => setSelectedId(resource.id)}>
          <span className="resource-kind">{resource.kind === "instruction" ? "INS" : "SKL"}</span><span><strong>{resource.name}</strong><small>{resource.slug} · revision {resource.revisionNumber}</small></span>
        </button>)}
        {resources.data?.resources.length === 0 && <div className="empty-state"><strong>No shared resources</strong></div>}
      </section>
      <section className="resource-detail panel">
        {!selected && <div className="empty-state"><strong>Select a resource</strong><p>Inspect its immutable current revision and bindings.</p></div>}
        {selected && <>
          <div className="card-top"><span className="status-chip">{selected.kind}</span><span className="mono">r{selected.revisionNumber}</span></div><h2>{selected.name}</h2>
          <div className="file-list">{selectedFiles.map((file) => <a key={file.relativePath} href={`/api/v1/blobs/${file.blobSha256}`} download><span>{file.relativePath}</span><small>{file.mediaType}</small></a>)}</div>
          <form className="stack compact-form" onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem("replacement");
            if (input instanceof HTMLInputElement && input.files?.length) {
              const files = [...input.files];
              event.currentTarget.reset();
              void replaceResource({ resourceId: selected.id, revisionId: selected.revisionId, files });
            }
          }}><label>Replace complete file tree{selected.kind === "skill" ? <DirectoryInput name="replacement" required /> : <input name="replacement" type="file" multiple required />}</label>{actionError?.action === "replace" && <ErrorNotice error={actionError.error} />}<button disabled={pendingAction === "replace"}>Create new revision</button></form>
          <hr />
          <form className="stack compact-form" onSubmit={(event) => void setSelection(event)}>
            <h3>Apply to configuration</h3>
            <label>Configuration<select value={selectedConfigId ?? ""} onChange={(event) => setSelectedConfigId(event.target.value)} required><option value="">Choose…</option>{configSets.data?.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select></label>
            <label>Order<input name="sortOrder" type="number" min={0} defaultValue={0} /></label>
            <div className="check-grid">{AgentId.options.map((agent) => <label className="check" key={agent}><input name="agents" type="checkbox" value={agent} />{agent}</label>)}</div>
            <button disabled={!selectedConfig.data}>Save selection</button>
          </form>
        </>}
      </section>
    </div>
  </div>;
}

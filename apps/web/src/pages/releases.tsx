import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { Diagnostic } from "@agent-config-hub/protocol";

import {
  ApiClientError,
  ConfigSetDetail,
  ConfigSetList,
  ReleaseList,
  api,
  mutate,
  mutateEmpty,
} from "../api.js";
import { ErrorNotice } from "../auth.js";

const PublishResult = z.object({ releaseId: z.string(), releaseNumber: z.number().int(), diagnostics: Diagnostic.array() });
const RollbackResult = z.object({ releaseId: z.string(), releaseNumber: z.number().int() });
const DiffResult = z.object({ entries: z.array(z.object({
  target: z.string(), action: z.enum(["add", "change", "remove"]),
  beforeSha256: z.string().nullable(), afterSha256: z.string().nullable(),
  beforeSize: z.number().nullable(), afterSize: z.number().nullable(),
  beforeMediaType: z.string().nullable(), afterMediaType: z.string().nullable(),
  sensitive: z.boolean(), beforeText: z.string().optional(), afterText: z.string().optional(),
})) });

type DiagnosticItem = z.infer<typeof Diagnostic>;

export function ReleasesPage() {
  const queryClient = useQueryClient();
  const [configSetId, setConfigSetId] = useState("");
  const [notes, setNotes] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[] | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  const [diff, setDiff] = useState<z.infer<typeof DiffResult>>();
  const sets = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  const detail = useQuery({ queryKey: ["config-set", configSetId], queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail), enabled: Boolean(configSetId) });
  const releases = useQuery({ queryKey: ["releases", configSetId], queryFn: () => api(`/api/v1/config-sets/${configSetId}/releases`, ReleaseList), enabled: Boolean(configSetId) });

  const publish = async () => {
    if (!detail.data) return;
    setPending(true); setActionError(undefined);
    try {
      const result = await mutate(`/api/v1/config-sets/${configSetId}/releases`, PublishResult, { notes }, { revision: detail.data.configSet.draftRevision });
      setDiagnostics(result.data.diagnostics); setNotes("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (error) {
      setActionError(error);
      if (error instanceof ApiClientError) {
        const parsed = Diagnostic.array().safeParse(error.details);
        if (parsed.success) setDiagnostics(parsed.data);
      }
    } finally { setPending(false); }
  };
  const rollback = async (releaseId: string) => {
    if (!detail.data) return;
    setPending(true); setActionError(undefined);
    try {
      await mutate(`/api/v1/config-sets/${configSetId}/releases/${releaseId}/rollback`, RollbackResult, {}, { revision: detail.data.configSet.draftRevision });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["releases", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-set", configSetId] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (error) { setActionError(error); }
    finally { setPending(false); }
  };
  const remove = async (releaseId: string) => {
    try {
      await mutateEmpty(`/api/v1/config-sets/${configSetId}/releases/${releaseId}`, {}, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["releases", configSetId] });
    } catch (error) { setActionError(error); }
  };
  const compare = async () => {
    if (!afterId) return;
    try { setDiff(await api(`/api/v1/releases/${afterId}/diff${beforeId ? `?before=${beforeId}` : ""}`, DiffResult)); }
    catch (error) { setActionError(error); }
  };
  const blocking = diagnostics?.filter(({ severity }) => severity === "error").length ?? 0;

  return <div className="page-frame">
    <header className="page-header"><div><p className="eyebrow">Immutable history</p><h1>Releases</h1><p>Validate, freeze, compare, and restore exact output bytes.</p></div><label>Configuration<select value={configSetId} onChange={(event) => { setConfigSetId(event.target.value); setDiagnostics(null); }}><option value="">Choose…</option>{sets.data?.map((set) => <option value={set.id} key={set.id}>{set.name}</option>)}</select></label></header>
    {detail.data && <section className="publish-panel panel"><div><p className="eyebrow">Draft r{detail.data.configSet.draftRevision}</p><h2>Publish draft</h2><p className="muted">{detail.data.files.length} native files · {detail.data.selectedResources.length} shared resources. The server publishes only after the complete freeze pipeline reports zero blocking diagnostics.</p></div><label className="grow">Release notes<input value={notes} onChange={(event) => setNotes(event.target.value)} /></label><div className="button-row"><button className="primary" onClick={() => void publish()} disabled={pending}>Validate & publish immutable release</button></div></section>}
    {actionError !== undefined && <ErrorNotice error={actionError} />}
    {diagnostics && <section className="release-diagnostics panel"><header><strong>Authoritative release validation</strong><span>{blocking} blocking · {diagnostics.length} total</span></header>{diagnostics.length === 0 ? <p>The release was published after the complete freeze pipeline passed.</p> : diagnostics.map((item, index) => <div className={`diagnostic ${item.severity}`} key={`${item.code}-${index}`}><span>{item.severity}</span><code>{item.code}</code><p>{item.message}</p></div>)}</section>}
    <section className="compare-panel panel"><h2>Compare releases</h2><div className="form-row"><label>Before<select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}><option value="">Empty baseline</option>{releases.data?.map((release) => <option key={release.id} value={release.id}>r{release.releaseNumber}</option>)}</select></label><label>After<select value={afterId} onChange={(event) => setAfterId(event.target.value)}><option value="">Choose…</option>{releases.data?.map((release) => <option key={release.id} value={release.id}>r{release.releaseNumber}</option>)}</select></label><button onClick={() => void compare()}>Compare</button></div>{diff && <div className="diff-list">{diff.entries.map((entry) => <article key={entry.target}><span className={`diff-action ${entry.action}`}>{entry.action}</span><code>{entry.target}</code>{entry.sensitive ? <p>Content hidden: sensitive output</p> : <details><summary>{entry.beforeSize ?? 0} → {entry.afterSize ?? 0} bytes</summary><div className="conflict-columns"><pre>{entry.beforeText ?? entry.beforeSha256}</pre><pre>{entry.afterText ?? entry.afterSha256}</pre></div></details>}</article>)}</div>}</section>
    <div className="timeline">{releases.data?.map((release) => { const current = detail.data?.configSet.currentReleaseId === release.id; return <article className="panel" key={release.id}><span className="release-number">r{release.releaseNumber}</span><div><strong>{release.notes || "Release without notes"}</strong><p>{release.enabledAgents.join(" · ")} · draft {release.draftRevision}</p></div><time>{new Date(release.createdAt).toLocaleString()}</time><div className="button-row"><button onClick={() => void rollback(release.id)} disabled={pending || current}>Rollback</button><button className="danger" onClick={() => void remove(release.id)} disabled={current}>Delete</button>{current && <span className="status-chip">Current</span>}</div></article>; })}</div>
  </div>;
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCompare, Minus, Plus, Trash2, Undo2 } from "lucide-react";
import { motion } from "motion/react";
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
import { Chip, Field } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const PublishResult = z.object({
  releaseId: z.string(),
  releaseNumber: z.number().int(),
  diagnostics: Diagnostic.array(),
});
const RollbackResult = z.object({
  releaseId: z.string(),
  releaseNumber: z.number().int(),
});
const DiffResult = z.object({
  entries: z.array(z.object({
    target: z.string(),
    action: z.enum(["add", "change", "remove"]),
    beforeSha256: z.string().nullable(),
    afterSha256: z.string().nullable(),
    beforeSize: z.number().nullable(),
    afterSize: z.number().nullable(),
    beforeMediaType: z.string().nullable(),
    afterMediaType: z.string().nullable(),
    sensitive: z.boolean(),
    beforeText: z.string().optional(),
    afterText: z.string().optional(),
  })),
});

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
  const sets = useQuery({
    queryKey: ["config-sets"],
    queryFn: () => api("/api/v1/config-sets", ConfigSetList),
  });
  const detail = useQuery({
    queryKey: ["config-set", configSetId],
    queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail),
    enabled: Boolean(configSetId),
  });
  const releases = useQuery({
    queryKey: ["releases", configSetId],
    queryFn: () => api(`/api/v1/config-sets/${configSetId}/releases`, ReleaseList),
    enabled: Boolean(configSetId),
  });

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

  return (
    <Page
      index="05"
      eyebrow="Immutable history"
      title="Releases"
      lede="Validate, freeze, compare, and restore exact output bytes."
      actions={(
        <Field label="Configuration">
          <select
            value={configSetId}
            onChange={(event) => {
              setConfigSetId(event.target.value);
              setDiagnostics(null);
            }}
          >
            <option value="">Choose…</option>
            {sets.data?.map((set) => (
              <option value={set.id} key={set.id}>{set.name}</option>
            ))}
          </select>
        </Field>
      )}
    >
      {detail.data && (
        <section className="publish-panel panel">
          <div>
            <p className="eyebrow">Draft r{detail.data.configSet.draftRevision}</p>
            <h2 className="display-sm">Publish draft</h2>
            <div className="mono muted">
              <span>{detail.data.files.length} native files</span>
              <span> / </span>
              <span>{detail.data.selectedResources.length} shared resources</span>
            </div>
            <p className="muted">
              The server publishes only after the complete freeze pipeline reports zero blocking diagnostics.
            </p>
          </div>
          <Field label="Release notes">
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <div className="button-row">
            <MagneticButton
              className="btn btn-primary"
              onClick={() => void publish()}
              disabled={pending}
            >
              Validate &amp; publish immutable release
            </MagneticButton>
          </div>
        </section>
      )}

      {actionError !== undefined && <ErrorNotice error={actionError} />}

      {diagnostics && (
        <section className="release-diagnostics panel">
          <header>
            <strong>Authoritative release validation</strong>
            <span>{blocking} blocking · {diagnostics.length} total</span>
          </header>
          {diagnostics.length === 0
            ? <p>The release was published after the complete freeze pipeline passed.</p>
            : diagnostics.map((item, index) => (
              <div className={`diagnostic ${item.severity}`} key={`${item.code}-${index}`}>
                <span>{item.severity}</span>
                <code>{item.code}</code>
                <p>{item.message}</p>
              </div>
            ))}
        </section>
      )}

      <section className="compare-panel panel">
        <h2 className="display-sm">Compare releases</h2>
        <div className="form-row">
          <label>
            Before
            <select value={beforeId} onChange={(event) => setBeforeId(event.target.value)}>
              <option value="">Empty baseline</option>
              {releases.data?.map((release) => (
                <option key={release.id} value={release.id}>r{release.releaseNumber}</option>
              ))}
            </select>
          </label>
          <label>
            After
            <select value={afterId} onChange={(event) => setAfterId(event.target.value)}>
              <option value="">Choose…</option>
              {releases.data?.map((release) => (
                <option key={release.id} value={release.id}>r{release.releaseNumber}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={() => void compare()}>Compare</button>
        </div>
        {diff && (
          <div className="diff-list">
            {diff.entries.map((entry) => {
              const color = entry.action === "add"
                ? "var(--volt)"
                : entry.action === "change"
                  ? "var(--warn)"
                  : "var(--danger)";
              const ActionIcon = entry.action === "add"
                ? Plus
                : entry.action === "change"
                  ? GitCompare
                  : Minus;

              return (
                <article className={`diff-entry ${entry.action}`} key={entry.target}>
                  <ActionIcon
                    size={15}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    style={{ color }}
                  />
                  <span className="mono" style={{ color }}>{entry.action}</span>
                  <code>{entry.target}</code>
                  {entry.sensitive
                    ? <Chip tone="danger">sensitive</Chip>
                    : (
                      <details>
                        <summary>{entry.beforeSize ?? 0} → {entry.afterSize ?? 0} bytes</summary>
                        <div className="conflict-columns">
                          <pre>{entry.beforeText ?? entry.beforeSha256}</pre>
                          <pre>{entry.afterText ?? entry.afterSha256}</pre>
                        </div>
                      </details>
                    )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="timeline">
        {releases.data?.map((release, index) => {
          const current = detail.data?.configSet.currentReleaseId === release.id;
          return (
            <motion.article
              className="timeline-item"
              key={release.id}
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.04 }}
            >
              <span className="timeline-number">r{release.releaseNumber}</span>
              <div>
                <strong>{release.notes || "Release without notes"}</strong>
                <p className="mono muted">
                  {release.enabledAgents.join(" · ")} · draft {release.draftRevision}
                </p>
                <time className="mono muted">{new Date(release.createdAt).toLocaleString()}</time>
              </div>
              <div className="button-row">
                {current && <Chip tone="volt">Current</Chip>}
                <button
                  className="btn"
                  onClick={() => void rollback(release.id)}
                  disabled={pending || current}
                >
                  <Undo2 size={15} strokeWidth={1.5} aria-hidden="true" />
                  Rollback
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => void remove(release.id)}
                  disabled={current}
                >
                  <Trash2 size={15} strokeWidth={1.5} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </motion.article>
          );
        })}
      </div>
    </Page>
  );
}

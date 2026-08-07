import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, GitCompare, Minus, Plus, Trash2, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
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
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";

const EMPTY_SELECTION = "__none__";

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
type DiffEntry = z.infer<typeof DiffResult>["entries"][number];

function DiffDetails({ entry }: { entry: DiffEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 md:col-span-3 md:ml-7">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="px-0 text-muted-foreground">
          {open
            ? <ChevronDown aria-hidden="true" />
            : <ChevronRight aria-hidden="true" />}
          {entry.beforeSize ?? 0} → {entry.afterSize ?? 0} bytes
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="grid gap-3 md:grid-cols-2">
          {/* 与旧 .conflict-columns pre 一致:双轴有界滚动。diff 单侧可达 2 MiB,
              只开横向滚动会把页面撑到极高 */}
          <pre className="max-h-[300px] overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">
            {entry.beforeText ?? entry.beforeSha256}
          </pre>
          <pre className="max-h-[300px] overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs">
            {entry.afterText ?? entry.afterSha256}
          </pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ReleasesPage() {
  const queryClient = useQueryClient();
  const [configSetId, setConfigSetId] = useState("");
  const [notes, setNotes] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[] | null>(null);
  const [actionError, setActionError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [beforeId, setBeforeId] = useState("");
  const [afterId, setAfterId] = useState("");
  // diff 连同"它是为哪一对 before/after 算出来的"一起存,渲染时再比对当前选择。
  // 只存结果的话,切换选择或对比对象被删之后,页面就会在与选择器不一致的状态下
  // 继续展示旧结果。
  const [diff, setDiff] = useState<{
    beforeId: string;
    afterId: string;
    result: z.infer<typeof DiffResult>;
  }>();
  // 请求序号:比较是手动触发的并发请求,先发的慢响应不能覆盖后发的结果
  const compareRequest = useRef(0);
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
  // 删除某个 release 后(remove 会 invalidate ["releases"]),beforeId/afterId 可能
  // 指向已不存在的 release:受控 Select 会显示空白,compare 还会拿它去请求。
  // 与换配置组时的清空互补 —— 那条路径清 state,这条路径兜住列表本身的变化。
  const listedReleaseIds = new Set(releases.data?.map(({ id }) => id));
  const effectiveBeforeId = listedReleaseIds.has(beforeId) ? beforeId : "";
  const effectiveAfterId = listedReleaseIds.has(afterId) ? afterId : "";
  const visibleDiff = diff
    && diff.afterId === effectiveAfterId
    && diff.beforeId === effectiveBeforeId
    ? diff.result
    : undefined;

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
      toast.success("Release published");
    } catch (error) {
      setActionError(error);
      if (error instanceof ApiClientError) {
        const parsed = Diagnostic.array().safeParse(error.details);
        if (parsed.success) setDiagnostics(parsed.data);
      }
      toast.error(error instanceof Error ? error.message : "Release could not be published.");
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
    if (!effectiveAfterId) return;
    const requestId = ++compareRequest.current;
    const requestedBefore = effectiveBeforeId;
    const requestedAfter = effectiveAfterId;
    try {
      const result = await api(
        `/api/v1/releases/${requestedAfter}/diff${requestedBefore ? `?before=${requestedBefore}` : ""}`,
        DiffResult,
      );
      // 已被更晚的比较请求取代 —— 丢弃,否则慢的旧响应会覆盖新结果
      if (compareRequest.current !== requestId) return;
      setDiff({ beforeId: requestedBefore, afterId: requestedAfter, result });
    }
    catch (error) {
      if (compareRequest.current !== requestId) return;
      setActionError(error);
    }
  };
  const blocking = diagnostics?.filter(({ severity }) => severity === "error").length ?? 0;

  return (
    <Page
      title="Releases"
      lede="Validate, freeze, compare, and restore exact output bytes."
      actions={(
        <Field label="Configuration group" htmlFor="release-config-set" className="min-w-56">
          <Select
            value={configSetId || EMPTY_SELECTION}
            onValueChange={(value) => {
              setConfigSetId(value === EMPTY_SELECTION ? "" : value);
              setDiagnostics(null);
              // 换配置组后旧的 release id 不再存在于候选集,受控 Select 会显示空白
              setBeforeId("");
              setAfterId("");
              setDiff(undefined);
            }}
          >
            <SelectTrigger id="release-config-set" aria-label="Configuration group">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_SELECTION}>Choose…</SelectItem>
              {sets.data?.map((set) => (
                <SelectItem value={set.id} key={set.id}>{set.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    >
      {detail.data && (
        <Card>
          <CardHeader>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Draft r{detail.data.configSet.draftRevision}
            </p>
            <CardTitle>Publish draft</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="space-y-2">
              <p className="font-mono text-xs text-muted-foreground">
                {detail.data.files.length} native files / {detail.data.selectedResources.length} shared resources
              </p>
              <p className="text-sm text-muted-foreground">
                The server publishes only after the complete freeze pipeline reports zero blocking diagnostics.
              </p>
            </div>
            <Field label="Release notes">
              {/* 保持单行 input:原版是 <input>,换成 textarea 会把换行符写进请求体 */}
              <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
            <div>
              <Button onClick={() => void publish()} disabled={pending}>
                Validate &amp; publish immutable release
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {actionError !== undefined && <ErrorNotice error={actionError} />}

      {diagnostics && (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-4">
            <CardTitle>Authoritative release validation</CardTitle>
            <span className="text-xs text-muted-foreground">{blocking} blocking · {diagnostics.length} total</span>
          </CardHeader>
          <CardContent className="grid gap-2">
            {diagnostics.length === 0
              ? <p className="text-sm text-success">The release was published after the complete freeze pipeline passed.</p>
              : diagnostics.map((item, index) => (
                <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[auto_auto_1fr] sm:items-start" key={`${item.code}-${index}`}>
                  <Badge
                    className="justify-self-start"
                    variant={item.severity === "error"
                      ? "destructive"
                      : item.severity === "warning"
                        ? "warning"
                        : "outline"}
                  >
                    {item.severity}
                  </Badge>
                  <code className="text-xs text-muted-foreground">{item.code}</code>
                  <p className="text-sm">{item.message}</p>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Compare releases</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Before" htmlFor="release-before">
              <Select
                value={effectiveBeforeId || EMPTY_SELECTION}
                onValueChange={(value) => setBeforeId(value === EMPTY_SELECTION ? "" : value)}
              >
                <SelectTrigger id="release-before" aria-label="Before">
                  <SelectValue placeholder="Empty baseline" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_SELECTION}>Empty baseline</SelectItem>
                  {releases.data?.map((release) => (
                    <SelectItem key={release.id} value={release.id}>r{release.releaseNumber}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="After" htmlFor="release-after">
              <Select
                value={effectiveAfterId || EMPTY_SELECTION}
                onValueChange={(value) => setAfterId(value === EMPTY_SELECTION ? "" : value)}
              >
                <SelectTrigger id="release-after" aria-label="After">
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_SELECTION}>Choose…</SelectItem>
                  {releases.data?.map((release) => (
                    <SelectItem key={release.id} value={release.id}>r{release.releaseNumber}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button variant="outline" onClick={() => void compare()}>Compare</Button>
          </div>
          {/* 只渲染与当前有效选择一致的那份 diff:覆盖切换选择、对比对象被删、
              以及慢的旧响应三种不一致 */}
          {visibleDiff && (
            <div className="grid gap-3">
              {visibleDiff.entries.map((entry) => {
                const toneClass = entry.action === "add"
                  ? "text-success"
                  : entry.action === "change"
                    ? "text-warning"
                    : "text-destructive";
                const ActionIcon = entry.action === "add"
                  ? Plus
                  : entry.action === "change"
                    ? GitCompare
                    : Minus;

                return (
                  <article className="grid min-w-0 gap-2 rounded-md border border-border p-3 md:grid-cols-[auto_auto_1fr] md:items-center" key={entry.target}>
                    <ActionIcon className={toneClass} size={15} strokeWidth={1.5} aria-hidden="true" />
                    <span className={`font-mono text-xs ${toneClass}`}>{entry.action}</span>
                    <code className="min-w-0 truncate text-xs">{entry.target}</code>
                    {entry.sensitive
                      ? <Badge variant="destructive" className="justify-self-start md:col-span-3 md:ml-7">sensitive</Badge>
                      : <DiffDetails entry={entry} />}
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ol className="ml-2 border-l border-border pl-4">
        {releases.data?.map((release) => {
          const current = detail.data?.configSet.currentReleaseId === release.id;
          return (
            <li className="relative border-b border-border py-4 last:border-b-0" key={release.id}>
              <span className="absolute -left-[1.3rem] top-6 size-2 rounded-full bg-border" aria-hidden="true" />
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">r{release.releaseNumber}</span>
                    {current && <Badge variant="success">Current</Badge>}
                  </div>
                  <strong className="block text-sm">{release.notes || "Release without notes"}</strong>
                  <p className="font-mono text-xs text-muted-foreground">
                    {release.enabledAgents.join(" · ")} · draft {release.draftRevision}
                  </p>
                  <time className="font-mono text-xs text-muted-foreground">{new Date(release.createdAt).toLocaleString()}</time>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void rollback(release.id)}
                    disabled={pending || current}
                  >
                    <Undo2 aria-hidden="true" />
                    Rollback
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void remove(release.id)}
                    disabled={current}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Page>
  );
}

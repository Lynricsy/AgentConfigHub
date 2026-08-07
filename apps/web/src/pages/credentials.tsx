import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Copy, Eye, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { AgentId } from "@agent-config-hub/protocol";

import { ConfigSetDetail, ConfigSetList, CredentialList, api, mutate } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";

const CredentialResult = CredentialList.element;
const RevisionResult = z.object({ revision: z.number().int() });
const NONE = "__none__";
const INHERIT = "__inherit__";

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [rotatingId, setRotatingId] = useState<string>();
  const [revealingId, setRevealingId] = useState<string>();
  // 明文必须记住它属于哪条 credential:揭示 A 的请求在途时用户可以关掉弹窗再打开 B,
  // 只存字符串的话 A 的明文会渲染在 B 的弹窗里(错误已经按 id 过滤了,明文却没有)
  const [revealed, setRevealed] = useState<{ id: string; value: string }>();
  const [configSetId, setConfigSetId] = useState("");
  const [addSlotCredentialId, setAddSlotCredentialId] = useState(NONE);
  const [pendingAction, setPendingAction] = useState<"create" | "rotate" | "reveal">();
  // 三个动作各自一个错误槽。共用一个槽时,虽然渲染处按 action 过滤,但**写入**会互相
  // 覆盖:reveal 的失败落地就会把 create 表单里正在显示的失败挤掉(reveal 按钮并不会
  // 因为 create 在途而 disabled,两者可以重叠)。
  const [createError, setCreateError] = useState<unknown>();
  const [rotateError, setRotateError] = useState<{ id: string; error: unknown }>();
  const [revealError, setRevealError] = useState<{ id: string; error: unknown }>();
  const credentials = useQuery({ queryKey: ["credentials"], queryFn: () => api("/api/v1/credentials", CredentialList) });
  const configSets = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  // 选中的配置组可能已被别处删除;列表加载完成后若不再包含它,就退回未选择态,
  // 否则受控 Select 会显示空白,而 query 还在按不存在的 id 取数据
  const effectiveConfigSetId = configSetId && configSets.data
    && !configSets.data.some(({ id }) => id === configSetId)
    ? ""
    : configSetId;
  const config = useQuery({
    queryKey: ["config-set", effectiveConfigSetId],
    queryFn: () => api(`/api/v1/config-sets/${effectiveConfigSetId}`, ConfigSetDetail),
    enabled: Boolean(effectiveConfigSetId),
  });
  const revealedValue = revealed !== undefined && revealed.id === revealingId
    ? revealed.value
    : undefined;
  useEffect(() => {
    if (revealed === undefined) return;
    const timer = window.setTimeout(() => setRevealed(undefined), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  useEffect(() => () => setRevealed(undefined), []);

  const submitSensitive = async (
    event: FormEvent<HTMLFormElement>,
    action: "create" | "rotate" | "reveal",
    id?: string,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = action === "create"
      ? { label: String(data.get("label")), provider: String(data.get("provider")), value: String(data.get("value")) }
      : action === "rotate"
        ? { value: String(data.get("value")) }
        : { password: String(data.get("password")) };
    form.reset();
    setPendingAction(action);
    if (action === "create") setCreateError(undefined);
    else if (action === "rotate" && id) setRotateError(undefined);
    else if (action === "reveal" && id) setRevealError(undefined);
    try {
      if (action === "create") {
        await mutate("/api/v1/credentials", CredentialResult, input);
        setCreating(false);
        toast.success("Credential created");
      } else if (action === "rotate" && id) {
        await mutate(`/api/v1/credentials/${id}/rotate`, CredentialResult, input);
        setRotatingId(undefined);
        toast.success("Credential updated");
      } else if (action === "reveal" && id) {
        const result = await mutate(`/api/v1/credentials/${id}/reveal`, z.object({ value: z.string() }), input);
        setRevealed({ id, value: result.data.value });
        toast.success("Credential revealed");
      }
      if (action !== "reveal") await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["credentials"] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (error) {
      if (action === "create") setCreateError(error);
      else if (action === "rotate" && id) setRotateError({ id, error });
      else if (action === "reveal" && id) setRevealError({ id, error });
      toast.error(action === "create"
        ? "Could not create credential"
        : action === "rotate"
          ? "Could not update credential"
          : "Could not reveal credential");
    } finally {
      setPendingAction(undefined);
    }
  };

  const bind = async (slotName: string, credentialId: string | null, agentId?: string) => {
    if (!config.data) return;
    const suffix = agentId ? `/agents/${agentId}` : "";
    try {
      await mutate(
        `/api/v1/config-sets/${config.data.configSet.id}/secret-slots/${encodeURIComponent(slotName)}${suffix}`,
        RevisionResult,
        { credentialId },
        { method: "PUT", revision: config.data.configSet.draftRevision },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config-set", config.data.configSet.id] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
      toast.success("Credential binding updated");
    } catch {
      toast.error("Could not update credential binding");
    }
  };
  const closeReveal = () => {
    setRevealingId(undefined);
    setRevealed(undefined);
    setRevealError(undefined);
  };

  return (
    <Page
      title="Credentials"
      lede="Values remain masked; reveal requires password re-authentication."
      actions={
        <Button onClick={() => setCreating((value) => !value)} type="button">
          {creating ? "Cancel" : "New credential"}
        </Button>
      }
    >
      {creating && (
        <Card className="mb-4">
          <form
            className="grid gap-4 p-4 md:grid-cols-3"
            onSubmit={(event) => void submitSensitive(event, "create")}
          >
            <Field label="Label">
              <Input name="label" required />
            </Field>
            <Field label="Provider">
              <Input name="provider" required />
            </Field>
            <Field label="Secret value">
              <Input name="value" type="password" required />
            </Field>
            <div className="flex items-center gap-3 md:col-span-3">
              <Button disabled={pendingAction === "create"} type="submit">
                Encrypt & save
              </Button>
              {createError !== undefined && <ErrorNotice error={createError} />}
            </div>
          </form>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {credentials.data?.map((credential) => (
          <Card key={credential.id}>
            <CardHeader className="flex-row items-center justify-between gap-2">
              {/* provider 最长 120 字符,Badge 基类是 whitespace-nowrap,
                  必须给它可收缩的 min-w-0 + truncate,否则会挤走/溢出 revision */}
              <Badge className="min-w-0" variant="outline">
                <span className="truncate">{credential.provider}</span>
              </Badge>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">r{credential.revision}</span>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CardTitle>{credential.label}</CardTitle>
              <code className="font-mono text-xs text-muted-foreground">{credential.maskedValue}</code>
              <p className="text-xs text-muted-foreground">{credential.referenceCount} references</p>
            </CardContent>
            <CardFooter>
              {/* 每张卡片都有同名的 Rotate/Reveal,只读文案对屏幕阅读器是歧义的 —— 带上标签 */}
              <Button
                aria-label={`Rotate ${credential.label}`}
                variant="outline"
                size="sm"
                onClick={() => setRotatingId(credential.id)}
                type="button"
              >
                <RotateCw size={15} strokeWidth={1.5} aria-hidden="true" />
                Rotate
              </Button>
              <Button
                aria-label={`Reveal ${credential.label}`}
                variant="outline"
                size="sm"
                onClick={() => {
                  setRevealingId(credential.id);
                  setRevealed(undefined);
                }}
                type="button"
              >
                <Eye size={15} strokeWidth={1.5} aria-hidden="true" />
                Reveal
              </Button>
            </CardFooter>
            {rotatingId === credential.id && (
              <form
                className="flex flex-col gap-3 border-t border-border p-4"
                onSubmit={(event) => void submitSensitive(event, "rotate", credential.id)}
              >
                <Field label="New value">
                  <Input name="value" type="password" required autoFocus />
                </Field>
                {rotateError?.id === credential.id
                  && <ErrorNotice error={rotateError.error} />}
                <Button
                  variant="outline"
                  disabled={pendingAction === "rotate"}
                  type="submit"
                >
                  Save revision
                </Button>
              </form>
            )}
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader className="gap-3 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Effective bindings</p>
            <CardTitle>Secret slot matrix</CardTitle>
          </div>
          <Field label="Configuration group" htmlFor="credentials-config-set" className="w-full md:w-72">
            <Select
              value={effectiveConfigSetId || NONE}
              onValueChange={(value) => setConfigSetId(value === NONE ? "" : value)}
            >
              <SelectTrigger id="credentials-config-set" aria-label="Configuration group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Choose…</SelectItem>
                {configSets.data?.map((set) => (
                  <SelectItem key={set.id} value={set.id}>{set.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardHeader>
        {config.data && (
          <CardContent className="p-0">
            <form
              className="grid gap-2 border-b border-border p-4 sm:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void bind(
                  String(data.get("slotName")),
                  addSlotCredentialId === NONE ? null : addSlotCredentialId,
                );
              }}
            >
              <Input
                name="slotName"
                pattern="[A-Z][A-Z0-9_]*"
                placeholder="MODEL_API_KEY"
                required
              />
              <Select value={addSlotCredentialId} onValueChange={setAddSlotCredentialId}>
                <SelectTrigger aria-label="Credential">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unbound</SelectItem>
                  {credentials.data?.map((credential) => (
                    <SelectItem value={credential.id} key={credential.id}>
                      {credential.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" type="submit">Add slot</Button>
            </form>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Slot</TableHead>
                    <TableHead>Default</TableHead>
                    {AgentId.options.map((agent) => (
                      <TableHead className="font-mono normal-case" key={agent}>{agent}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {config.data.secretSlots.slots.map((slot) => (
                    <TableRow key={slot.id}>
                      <TableCell className="min-w-44 font-mono text-xs font-semibold">{slot.name}</TableCell>
                      <TableCell className="min-w-48">
                        <Select
                          value={slot.defaultCredentialId ?? NONE}
                          onValueChange={(value) => void bind(slot.name, value === NONE ? null : value)}
                        >
                          <SelectTrigger aria-label={`${slot.name} default`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>Unbound</SelectItem>
                            {credentials.data?.map((credential) => (
                              <SelectItem key={credential.id} value={credential.id}>
                                {credential.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      {AgentId.options.map((agent) => {
                        const override = config.data.secretSlots.overrides.find(
                          (item) => item.secretSlotId === slot.id && item.agentId === agent,
                        );
                        return (
                          <TableCell className="min-w-48" key={agent}>
                            <Select
                              value={override?.credentialId ?? INHERIT}
                              onValueChange={(value) => void bind(
                                slot.name,
                                value === INHERIT ? null : value,
                                agent,
                              )}
                            >
                              <SelectTrigger
                                aria-label={`${slot.name} for ${agent}`}
                                className={override
                                  ? "border-primary/50 text-foreground"
                                  : "text-muted-foreground"}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={INHERIT}>Inherit</SelectItem>
                                {credentials.data?.map((credential) => (
                                  <SelectItem key={credential.id} value={credential.id}>
                                    {credential.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        )}
      </Card>

      <Dialog
        open={revealingId !== undefined}
        onOpenChange={(open) => {
          if (!open) closeReveal();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reveal credential</DialogTitle>
            <DialogDescription>Sensitive action</DialogDescription>
          </DialogHeader>
          {revealingId && revealedValue === undefined ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => void submitSensitive(event, "reveal", revealingId)}
            >
              <Field label="Administrator password">
                <Input name="password" type="password" required autoFocus />
              </Field>
              {revealError?.id === revealingId && (
                <ErrorNotice error={revealError.error} />
              )}
              <DialogFooter>
                <Button disabled={pendingAction === "reveal"} type="submit">
                  Reveal once
                </Button>
              </DialogFooter>
            </form>
          ) : revealedValue !== undefined ? (
            <div className="flex flex-col gap-4">
              <code className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-sm">
                {revealedValue}
              </code>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(revealedValue)}
                  type="button"
                >
                  <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
                  Copy
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { CircleCheck, GitBranch } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ApiClientError, ConfigSetList, api, mutate, type ConfigSet } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card } from "../ui/card.js";
import { Empty } from "../ui/empty.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.js";
import { Loading } from "../ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";

const NEW_GROUP = "__new__";

function availableAgents(configSet: ConfigSet | undefined) {
  return configSet
    ? AgentId.options.filter((agentId) => !configSet.enabledAgents.includes(agentId))
    : AgentId.options;
}

export function ConfigSetListPage() {
  const [creating, setCreating] = useState(false);
  const [groupId, setGroupId] = useState(NEW_GROUP);
  const [agentId, setAgentId] = useState<(typeof AgentId.options)[number]>("claude-code");
  const [view, setView] = useState<"group" | "agent">("group");
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  const selectedGroup = query.data?.find((configSet) => configSet.id === groupId);
  const selectableAgents = availableAgents(selectedGroup);
  // 冲突后重取 config-sets 可能让候选集不再包含 agentId(受控 Select 会显示空白,
  // 且重试会提交一个控件里并不存在的 agent),所以读值一律走候选集内的有效值
  const effectiveAgentId = selectableAgents.includes(agentId) ? agentId : selectableAgents[0];
  const create = useMutation({
    mutationFn: async (input:
      | {
          kind: "new";
          agentId: (typeof AgentId.options)[number];
          name: string;
          slug: string;
        }
      | {
          kind: "existing";
          groupId: string;
          agentId: (typeof AgentId.options)[number];
          revision: number;
        },
    ) => {
      if (input.kind === "new") {
        return await mutate(
          "/api/v1/config-sets",
          z.object({ id: z.string(), revision: z.number() }),
          { name: input.name, slug: input.slug, agentId: input.agentId },
        );
      }
      return await mutate(
        `/api/v1/config-sets/${input.groupId}/configs`,
        z.object({ revision: z.number() }),
        { agentId: input.agentId },
        { revision: input.revision },
      );
    },
    onSuccess: async () => {
      setCreating(false);
      toast.success("Configuration created.");
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    },
    onError: async (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create configuration.");
      if (error instanceof ApiClientError && error.code === "REVISION_CONFLICT") {
        await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
      }
    },
  });
  const toggleCreating = () => {
    if (creating) {
      setCreating(false);
      return;
    }
    const initialGroup = query.data
      ?.find((configSet) => availableAgents(configSet).length > 0)
      ?.id ?? NEW_GROUP;
    const group = query.data?.find((configSet) => configSet.id === initialGroup);
    setGroupId(initialGroup);
    setAgentId(availableAgents(group)[0] ?? "claude-code");
    create.reset();
    setCreating(true);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!effectiveAgentId) return;
    const data = new FormData(event.currentTarget);
    if (selectedGroup) {
      create.mutate({
        kind: "existing",
        groupId: selectedGroup.id,
        agentId: effectiveAgentId,
        revision: selectedGroup.draftRevision,
      });
      return;
    }
    create.mutate({
      kind: "new",
      agentId: effectiveAgentId,
      name: String(data.get("name")),
      slug: String(data.get("slug")),
    });
  };
  const card = (configSet: ConfigSet, cardAgentId: (typeof AgentId.options)[number]) => {
    const dirty = configSet.currentReleaseRevision !== configSet.draftRevision;
    return (
      <Link
        className="rounded-lg transition-colors duration-150 hover:border-ring/50"
        key={`${configSet.id}-${cardAgentId}`}
        to={`/config-sets/${configSet.id}/configs/${cardAgentId}`}
      >
        <Card className="h-full transition-colors duration-150 hover:border-ring/50">
          <div className="flex flex-col items-start gap-3 p-4">
            <Badge variant={dirty ? "warning" : "success"}>
              {dirty
                ? <GitBranch aria-hidden="true" />
                : <CircleCheck aria-hidden="true" />}
              {dirty ? "Draft changed" : "Published"}
            </Badge>
            <div className="space-y-1">
              <p className="font-mono text-xs text-muted-foreground">{configSet.slug}</p>
              <h3 className="text-sm font-semibold">{configSet.name}</h3>
              <p className="text-sm text-muted-foreground">
                Agent · <span className="font-mono text-foreground">{cardAgentId}</span>
              </p>
            </div>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <span className="font-mono">Draft r{configSet.draftRevision}</span>
            <span className="font-mono">
              {configSet.currentReleaseNumber
                ? `Release ${configSet.currentReleaseNumber}`
                : "Never released"}
            </span>
          </footer>
        </Card>
      </Link>
    );
  };
  const configCount = query.data?.reduce(
    (count, configSet) => count + configSet.enabledAgents.length,
    0,
  ) ?? 0;

  return (
    <Page
      title="Configuration sets"
      lede="Agent configurations organized within shared release groups."
      actions={
        <Button disabled={query.isPending} onClick={toggleCreating}>
          {creating ? "Cancel" : "New config"}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {creating && (
          <Card>
            <form className="grid gap-4 p-4 sm:grid-cols-2" onSubmit={submit}>
              <Field
                className="sm:col-span-2"
                htmlFor="config-create-group"
                label="Configuration group"
              >
                <Select
                  value={groupId}
                  onValueChange={(nextGroupId) => {
                    const group = query.data?.find((configSet) => configSet.id === nextGroupId);
                    setGroupId(nextGroupId);
                    setAgentId(availableAgents(group)[0] ?? "claude-code");
                  }}
                >
                  <SelectTrigger
                    aria-label="Configuration group"
                    id="config-create-group"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {query.data?.map((configSet) => (
                      <SelectItem key={configSet.id} value={configSet.id}>
                        {configSet.name} · {configSet.slug}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_GROUP}>New configuration group…</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {groupId === NEW_GROUP && (
                <>
                  <Field label="Group name">
                    <Input name="name" placeholder="Personal workstation" required />
                  </Field>
                  <Field label="Group slug">
                    <Input
                      name="slug"
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      placeholder="personal"
                      required
                    />
                  </Field>
                </>
              )}
              <Field
                className="sm:col-span-2"
                htmlFor="config-create-agent"
                label="Agent"
              >
                <Select
                  value={effectiveAgentId ?? ""}
                  disabled={selectableAgents.length === 0}
                  onValueChange={(value) => setAgentId(AgentId.parse(value))}
                >
                  <SelectTrigger aria-label="Agent" id="config-create-agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableAgents.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {selectableAgents.length === 0 && (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  This configuration group already contains every Agent.
                </p>
              )}
              {create.error && (
                <div className="sm:col-span-2">
                  <ErrorNotice error={create.error} />
                </div>
              )}
              <div className="sm:col-span-2">
                <Button
                  disabled={create.isPending || selectableAgents.length === 0}
                  type="submit"
                >
                  Create config
                </Button>
              </div>
            </form>
          </Card>
        )}

        {query.isPending && <Loading label="Loading configurations…" />}
        {query.error && <ErrorNotice error={query.error} />}

        {configCount > 0 && (
          <Tabs
            aria-label="Organize configurations"
            value={view}
            onValueChange={(value) => setView(value as "group" | "agent")}
          >
            <TabsList>
              <TabsTrigger value="group">By group</TabsTrigger>
              <TabsTrigger value="agent">By Agent</TabsTrigger>
            </TabsList>
            <TabsContent className="mt-5 space-y-6" value="group">
              {query.data?.map((configSet) => {
                const groupAgents = AgentId.options.filter((option) => configSet.enabledAgents.includes(option));
                if (groupAgents.length === 0) return null;
                return (
                  <section
                    aria-labelledby={`config-group-${configSet.id}`}
                    className="space-y-3"
                    key={configSet.id}
                  >
                    <h2 className="text-sm font-semibold" id={`config-group-${configSet.id}`}>
                      {configSet.name}
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {groupAgents.map((option) => card(configSet, option))}
                    </div>
                  </section>
                );
              })}
            </TabsContent>
            <TabsContent className="mt-5 space-y-6" value="agent">
              {AgentId.options.map((option) => {
                const groups = query.data?.filter((configSet) => configSet.enabledAgents.includes(option)) ?? [];
                if (groups.length === 0) return null;
                return (
                  <section
                    aria-labelledby={`config-agent-${option}`}
                    className="space-y-3"
                    key={option}
                  >
                    <h2 className="font-mono text-sm font-semibold" id={`config-agent-${option}`}>
                      {option}
                    </h2>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {groups.map((configSet) => card(configSet, option))}
                    </div>
                  </section>
                );
              })}
            </TabsContent>
          </Tabs>
        )}

        {configCount === 0 && !query.isPending && (
          <Empty
            title="No configurations"
            hint="Create an Agent configuration to begin managing native files."
          />
        )}
      </div>
    </Page>
  );
}

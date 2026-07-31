import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { CircleCheck, GitBranch } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router-dom";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ApiClientError, ConfigSetList, api, mutate, type ConfigSet } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Chip, Empty, Field, Loading } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

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
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    },
    onError: async (error) => {
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
    const data = new FormData(event.currentTarget);
    if (selectedGroup) {
      create.mutate({
        kind: "existing",
        groupId: selectedGroup.id,
        agentId,
        revision: selectedGroup.draftRevision,
      });
      return;
    }
    create.mutate({
      kind: "new",
      agentId,
      name: String(data.get("name")),
      slug: String(data.get("slug")),
    });
  };
  const card = (configSet: ConfigSet, cardAgentId: (typeof AgentId.options)[number], index: number) => {
    const dirty = configSet.currentReleaseRevision !== configSet.draftRevision;
    return (
      <motion.div
        key={`${configSet.id}-${cardAgentId}`}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ y: -4 }}
        transition={{ type: "spring", delay: index * 0.05 }}
      >
        <Link className="card" to={`/config-sets/${configSet.id}/configs/${cardAgentId}`}>
          <Chip tone={dirty ? "warn" : undefined} icon={dirty ? GitBranch : CircleCheck}>
            {dirty ? "Draft changed" : "Published"}
          </Chip>
          <p className="mono">{configSet.slug}</p>
          <h3 className="display-sm">{configSet.name}</h3>
          <p>Agent · <span className="mono">{cardAgentId}</span></p>
          <footer>
            <span className="mono">Draft r{configSet.draftRevision}</span>
            <span className="mono">
              {configSet.currentReleaseNumber
                ? `Release ${configSet.currentReleaseNumber}`
                : "Never released"}
            </span>
          </footer>
        </Link>
      </motion.div>
    );
  };
  const configCount = query.data?.reduce(
    (count, configSet) => count + configSet.enabledAgents.length,
    0,
  ) ?? 0;

  return (
    <Page
      index="01"
      eyebrow="Profiles"
      title="Configuration sets"
      lede="Agent configurations organized within shared release groups."
      actions={
        <MagneticButton
          className="btn btn-primary"
          disabled={query.isPending}
          onClick={toggleCreating}
        >
          {creating ? "Cancel" : "New config"}
        </MagneticButton>
      }
    >
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ overflow: "hidden" }}
          >
            <form className="panel config-create-form" onSubmit={submit}>
              <Field label="Configuration group">
                <select
                  value={groupId}
                  onChange={(event) => {
                    const nextGroupId = event.target.value;
                    const group = query.data?.find((configSet) => configSet.id === nextGroupId);
                    setGroupId(nextGroupId);
                    setAgentId(availableAgents(group)[0] ?? "claude-code");
                  }}
                >
                  {query.data?.map((configSet) => (
                    <option key={configSet.id} value={configSet.id}>
                      {configSet.name} · {configSet.slug}
                    </option>
                  ))}
                  <option value={NEW_GROUP}>New configuration group…</option>
                </select>
              </Field>
              {groupId === NEW_GROUP && (
                <>
                  <Field label="Group name">
                    <input name="name" placeholder="Personal workstation" required />
                  </Field>
                  <Field label="Group slug">
                    <input
                      name="slug"
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      placeholder="personal"
                      required
                    />
                  </Field>
                </>
              )}
              <Field label="Agent">
                <select
                  value={agentId}
                  disabled={selectableAgents.length === 0}
                  onChange={(event) => setAgentId(AgentId.parse(event.target.value))}
                >
                  {selectableAgents.map((option) => <option key={option}>{option}</option>)}
                </select>
              </Field>
              {selectableAgents.length === 0 && (
                <p className="muted">This configuration group already contains every Agent.</p>
              )}
              {create.error && <ErrorNotice error={create.error} />}
              <MagneticButton
                className="btn btn-primary"
                disabled={create.isPending || selectableAgents.length === 0}
                type="submit"
              >
                Create config
              </MagneticButton>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {query.isPending && <Loading label="Loading configurations…" />}
      {query.error && <ErrorNotice error={query.error} />}

      {configCount > 0 && (
        <div className="config-view-toggle" aria-label="Organize configurations">
          <button className="btn" aria-pressed={view === "group"} onClick={() => setView("group")}>
            By group
          </button>
          <button className="btn" aria-pressed={view === "agent"} onClick={() => setView("agent")}>
            By Agent
          </button>
        </div>
      )}

      <div className="config-sections">
        {view === "group"
          ? query.data?.map((configSet) => {
              const groupAgents = AgentId.options.filter((option) => configSet.enabledAgents.includes(option));
              if (groupAgents.length === 0) return null;
              return (
                <section
                  aria-labelledby={`config-group-${configSet.id}`}
                  className="config-section"
                  key={configSet.id}
                >
                  <h2 id={`config-group-${configSet.id}`}>{configSet.name}</h2>
                  <div className="card-grid">
                    {groupAgents.map((option, index) => card(configSet, option, index))}
                  </div>
                </section>
              );
            })
          : AgentId.options.map((option) => {
              const groups = query.data?.filter((configSet) => configSet.enabledAgents.includes(option)) ?? [];
              if (groups.length === 0) return null;
              return (
                <section
                  aria-labelledby={`config-agent-${option}`}
                  className="config-section"
                  key={option}
                >
                  <h2 id={`config-agent-${option}`}>{option}</h2>
                  <div className="card-grid">
                    {groups.map((configSet, index) => card(configSet, option, index))}
                  </div>
                </section>
              );
            })}
      </div>

      {configCount === 0 && !query.isPending && (
        <Empty
          title="No configurations"
          hint="Create an Agent configuration to begin managing native files."
        />
      )}
    </Page>
  );
}

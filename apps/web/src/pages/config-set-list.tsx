import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { CircleCheck, GitBranch } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router-dom";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ConfigSetList, api, mutate } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Chip, Empty, Field, Loading } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const agents = AgentId.options;

export function ConfigSetListPage() {
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  const create = useMutation({
    mutationFn: (input: { name: string; slug: string; enabledAgents: string[] }) => mutate(
      "/api/v1/config-sets",
      z.object({ id: z.string(), revision: z.number() }),
      input,
    ),
    onSuccess: async () => {
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["config-sets"] });
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      name: String(data.get("name")),
      slug: String(data.get("slug")),
      enabledAgents: data.getAll("agents").map(String),
    });
  };

  return (
    <Page
      index="01"
      eyebrow="Profiles"
      title="Configuration sets"
      lede="Independent drafts and release histories for each environment."
      actions={
        <MagneticButton
          className="btn btn-primary"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? "Cancel" : "New configuration"}
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
            <form className="panel" onSubmit={submit}>
              <Field label="Name">
                <input name="name" placeholder="Personal workstation" required />
              </Field>
              <Field label="Slug">
                <input
                  name="slug"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="personal"
                  required
                />
              </Field>
              <fieldset>
                <legend>Enabled agents</legend>
                <div className="check-grid">
                  {agents.map((agent) => (
                    <label key={agent} className="check">
                      <input
                        type="checkbox"
                        name="agents"
                        value={agent}
                        defaultChecked={agent === "claude-code"}
                      />
                      {agent}
                    </label>
                  ))}
                </div>
              </fieldset>
              {create.error && <ErrorNotice error={create.error} />}
              <MagneticButton
                className="btn btn-primary"
                disabled={create.isPending}
                type="submit"
              >
                Create set
              </MagneticButton>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {query.isPending && <Loading label="Loading configurations…" />}
      {query.error && <ErrorNotice error={query.error} />}

      <div className="card-grid">
        {query.data?.map((configSet, index) => {
          const dirty = configSet.currentReleaseRevision !== configSet.draftRevision;
          return (
            <motion.div
              key={configSet.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ y: -4 }}
              transition={{ type: "spring", delay: index * 0.05 }}
            >
              <Link className="card" to={`/config-sets/${configSet.id}`}>
                <Chip
                  tone={dirty ? "warn" : undefined}
                  icon={dirty ? GitBranch : CircleCheck}
                >
                  {dirty ? "Draft changed" : "Published"}
                </Chip>
                <p className="mono">{configSet.slug}</p>
                <h2 className="display-sm">{configSet.name}</h2>
                <p>{configSet.enabledAgents.join(" · ")}</p>
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
        })}
      </div>

      {query.data?.length === 0 && (
        <Empty
          title="No configuration sets"
          hint="Create one to begin managing agent-native files."
        />
      )}
    </Page>
  );
}

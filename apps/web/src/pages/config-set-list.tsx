import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ConfigSetList, api, mutate } from "../api.js";
import { ErrorNotice } from "../auth.js";

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

  return <div className="page-frame">
    <header className="page-header">
      <div><p className="eyebrow">Profiles</p><h1>Configuration sets</h1><p>Independent drafts and release histories for each environment.</p></div>
      <button className="primary" onClick={() => setCreating((value) => !value)}>{creating ? "Cancel" : "New configuration"}</button>
    </header>
    {creating && <form className="inline-form panel" onSubmit={submit}>
      <label>Name<input name="name" placeholder="Personal workstation" required /></label>
      <label>Slug<input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="personal" required /></label>
      <fieldset><legend>Enabled agents</legend><div className="check-grid">
        {agents.map((agent) => <label key={agent} className="check"><input type="checkbox" name="agents" value={agent} defaultChecked={agent === "claude-code"} />{agent}</label>)}
      </div></fieldset>
      {create.error && <ErrorNotice error={create.error} />}
      <button className="primary" disabled={create.isPending}>Create set</button>
    </form>}
    {query.isPending && <div className="center-state"><span className="spinner" />Loading configurations…</div>}
    {query.error && <ErrorNotice error={query.error} />}
    <div className="card-grid">
      {query.data?.map((configSet) => {
        const dirty = configSet.currentReleaseRevision !== configSet.draftRevision;
        return <Link className="config-card" to={`/config-sets/${configSet.id}`} key={configSet.id}>
          <div className="card-top"><span className={dirty ? "status-chip warning" : "status-chip"}>{dirty ? "Draft changed" : "Published"}</span><span className="mono">{configSet.slug}</span></div>
          <h2>{configSet.name}</h2>
          <p>{configSet.enabledAgents.join(" · ")}</p>
          <footer><span>Draft r{configSet.draftRevision}</span><span>{configSet.currentReleaseNumber ? `Release ${configSet.currentReleaseNumber}` : "Never released"}</span></footer>
        </Link>;
      })}
    </div>
    {query.data?.length === 0 && <div className="empty-state"><strong>No configuration sets</strong><p>Create one to begin managing agent-native files.</p></div>}
  </div>;
}

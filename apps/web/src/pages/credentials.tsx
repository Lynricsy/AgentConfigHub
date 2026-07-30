import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Copy, Eye, RotateCw } from "lucide-react";

import { AgentId } from "@agent-config-hub/protocol";

import { ConfigSetDetail, ConfigSetList, CredentialList, api, mutate } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Chip, Field, Modal } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const CredentialResult = CredentialList.element;
const RevisionResult = z.object({ revision: z.number().int() });

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [rotatingId, setRotatingId] = useState<string>();
  const [revealingId, setRevealingId] = useState<string>();
  const [revealedValue, setRevealedValue] = useState<string>();
  const [configSetId, setConfigSetId] = useState("");
  const [pendingAction, setPendingAction] = useState<"create" | "rotate" | "reveal">();
  const [actionError, setActionError] = useState<{
    action: "create" | "rotate" | "reveal";
    id: string | undefined;
    error: unknown;
  }>();
  const credentials = useQuery({ queryKey: ["credentials"], queryFn: () => api("/api/v1/credentials", CredentialList) });
  const configSets = useQuery({ queryKey: ["config-sets"], queryFn: () => api("/api/v1/config-sets", ConfigSetList) });
  const config = useQuery({
    queryKey: ["config-set", configSetId],
    queryFn: () => api(`/api/v1/config-sets/${configSetId}`, ConfigSetDetail),
    enabled: Boolean(configSetId),
  });
  useEffect(() => {
    if (revealedValue === undefined) return;
    const timer = window.setTimeout(() => setRevealedValue(undefined), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealedValue]);
  useEffect(() => () => setRevealedValue(undefined), []);

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
    setActionError(undefined);
    try {
      if (action === "create") {
        await mutate("/api/v1/credentials", CredentialResult, input);
        setCreating(false);
      } else if (action === "rotate" && id) {
        await mutate(`/api/v1/credentials/${id}/rotate`, CredentialResult, input);
        setRotatingId(undefined);
      } else if (action === "reveal" && id) {
        const result = await mutate(`/api/v1/credentials/${id}/reveal`, z.object({ value: z.string() }), input);
        setRevealedValue(result.data.value);
      }
      if (action !== "reveal") await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["credentials"] }),
        queryClient.invalidateQueries({ queryKey: ["config-sets"] }),
      ]);
    } catch (error) {
      setActionError({ action, id, error });
    } finally {
      setPendingAction(undefined);
    }
  };

  const bind = async (slotName: string, credentialId: string | null, agentId?: string) => {
    if (!config.data) return;
    const suffix = agentId ? `/agents/${agentId}` : "";
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
  };
  const closeReveal = () => {
    setRevealingId(undefined);
    setRevealedValue(undefined);
    setActionError(undefined);
  };

  return (
    <Page
      index="04"
      eyebrow="Secret inventory"
      title="Credentials"
      lede="Values remain masked; reveal requires password re-authentication."
      actions={
        <MagneticButton
          className="btn btn-primary"
          onClick={() => setCreating((value) => !value)}
          type="button"
        >
          {creating ? "Cancel" : "New credential"}
        </MagneticButton>
      }
    >
      {creating && (
        <form
          className="section-panel stack"
          onSubmit={(event) => void submitSensitive(event, "create")}
        >
          <Field label="Label">
            <input name="label" required />
          </Field>
          <Field label="Provider">
            <input name="provider" required />
          </Field>
          <Field label="Secret value">
            <input name="value" type="password" required />
          </Field>
          <MagneticButton
            className="btn btn-primary"
            disabled={pendingAction === "create"}
            type="submit"
          >
            Encrypt & save
          </MagneticButton>
          {actionError?.action === "create" && (
            <ErrorNotice error={actionError.error} />
          )}
        </form>
      )}

      <div className="credential-grid">
        {credentials.data?.map((credential) => (
          <article className="credential-card" key={credential.id}>
            <div className="card-top">
              <Chip>{credential.provider}</Chip>
              <span className="mono">r{credential.revision}</span>
            </div>
            <h2 className="display-sm">{credential.label}</h2>
            <code>{credential.maskedValue}</code>
            <p className="muted">{credential.referenceCount} references</p>
            <div className="button-row">
              <button
                className="btn"
                onClick={() => setRotatingId(credential.id)}
                type="button"
              >
                <RotateCw size={15} strokeWidth={1.5} aria-hidden="true" />
                Rotate
              </button>
              <button
                className="btn"
                onClick={() => {
                  setRevealingId(credential.id);
                  setRevealedValue(undefined);
                }}
                type="button"
              >
                <Eye size={15} strokeWidth={1.5} aria-hidden="true" />
                Reveal
              </button>
            </div>
            {rotatingId === credential.id && (
              <form
                className="stack compact-form"
                onSubmit={(event) => void submitSensitive(event, "rotate", credential.id)}
              >
                <Field label="New value">
                  <input name="value" type="password" required autoFocus />
                </Field>
                {actionError?.action === "rotate"
                  && actionError.id === credential.id
                  && <ErrorNotice error={actionError.error} />}
                <button
                  className="btn"
                  disabled={pendingAction === "rotate"}
                  type="submit"
                >
                  Save revision
                </button>
              </form>
            )}
          </article>
        ))}
      </div>

      <section className="slot-section">
        <header>
          <div>
            <p className="eyebrow">Effective bindings</p>
            <h2 className="display-sm">Secret slot matrix</h2>
          </div>
          <Field label="Configuration">
            <select
              value={configSetId}
              onChange={(event) => setConfigSetId(event.target.value)}
            >
              <option value="">Choose…</option>
              {configSets.data?.map((set) => (
                <option key={set.id} value={set.id}>{set.name}</option>
              ))}
            </select>
          </Field>
        </header>
        {config.data && (
          <>
            <form
              className="add-slot"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void bind(String(data.get("slotName")), String(data.get("credentialId")) || null);
              }}
            >
              <input
                name="slotName"
                pattern="[A-Z][A-Z0-9_]*"
                placeholder="MODEL_API_KEY"
                required
              />
              <select name="credentialId">
                <option value="">Unbound</option>
                {credentials.data?.map((credential) => (
                  <option value={credential.id} key={credential.id}>
                    {credential.label}
                  </option>
                ))}
              </select>
              <button className="btn" type="submit">Add slot</button>
            </form>
            <div className="slot-matrix">
              <div className="slot-row slot-head">
                <span>Slot</span>
                <span>Default</span>
                {AgentId.options.map((agent) => <span key={agent}>{agent}</span>)}
              </div>
              {config.data.secretSlots.slots.map((slot) => (
                <div className="slot-row" key={slot.id}>
                  <strong>{slot.name}</strong>
                  <select
                    value={slot.defaultCredentialId ?? ""}
                    onChange={(event) => void bind(slot.name, event.target.value || null)}
                  >
                    <option value="">Unbound</option>
                    {credentials.data?.map((credential) => (
                      <option key={credential.id} value={credential.id}>
                        {credential.label}
                      </option>
                    ))}
                  </select>
                  {AgentId.options.map((agent) => {
                    const override = config.data.secretSlots.overrides.find(
                      (item) => item.secretSlotId === slot.id && item.agentId === agent,
                    );
                    return (
                      <select
                        className={override ? "override" : "inherited"}
                        key={agent}
                        value={override?.credentialId ?? ""}
                        onChange={(event) => void bind(
                          slot.name,
                          event.target.value || null,
                          agent,
                        )}
                      >
                        <option value="">Inherit</option>
                        {credentials.data?.map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.label}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {revealingId && (
        <Modal
          title="Reveal credential"
          eyebrow="Sensitive action"
          onClose={closeReveal}
        >
          {revealedValue === undefined ? (
            <form
              className="stack"
              onSubmit={(event) => void submitSensitive(event, "reveal", revealingId)}
            >
              <Field label="Administrator password">
                <input name="password" type="password" required autoFocus />
              </Field>
              {actionError?.action === "reveal" && actionError.id === revealingId && (
                <ErrorNotice error={actionError.error} />
              )}
              <MagneticButton
                className="btn btn-primary"
                disabled={pendingAction === "reveal"}
                type="submit"
              >
                Reveal once
              </MagneticButton>
            </form>
          ) : (
            <div className="revealed-secret">
              <code>{revealedValue}</code>
              <button
                className="btn"
                onClick={() => void navigator.clipboard.writeText(revealedValue)}
                type="button"
              >
                <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
                Copy
              </button>
            </div>
          )}
        </Modal>
      )}
    </Page>
  );
}

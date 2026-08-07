import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Ban, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { z } from "zod";

import { TokenList, api, mutate, mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Field, Panel } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const AutomationToken = z.object({ id: z.string(), token: z.string(), prefix: z.string() });

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [oneTimeToken, setOneTimeToken] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api("/api/v1/tokens", TokenList) });
  useEffect(() => {
    if (!oneTimeToken) return;
    const timer = window.setTimeout(() => setOneTimeToken(undefined), 60_000);
    return () => window.clearTimeout(timer);
  }, [oneTimeToken]);
  useEffect(() => () => setOneTimeToken(undefined), []);

  const approve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const userCode = String(new FormData(form).get("userCode"));
    form.reset(); setPending(true); setError(undefined);
    try { await mutateEmpty("/api/v1/devices/approve", { userCode }); }
    catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  const createAutomation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const label = String(new FormData(form).get("label"));
    form.reset(); setPending(true); setError(undefined);
    try {
      const result = await mutate("/api/v1/tokens/automation", AutomationToken, { label });
      setOneTimeToken(result.data.token);
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  const revoke = async (id: string) => {
    try {
      await mutateEmpty(`/api/v1/tokens/${id}`, {}, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
    } catch (cause) { setError(cause); }
  };

  return (
    <Page
      title="Devices & tokens"
      lede="Approve pairing codes, issue automation credentials, and revoke access immediately."
    >
      <div className="card-grid">
        <Panel eyebrow="Device pairing" title="Approve user code" icon={ShieldCheck}>
          <form className="stack" onSubmit={(event) => void approve(event)}>
            <p className="muted">Compare this code with the CLI before approval.</p>
            <Field label="Eight-character code">
              <input
                className="mono"
                style={{ letterSpacing: ".18em", textTransform: "uppercase" }}
                name="userCode"
                minLength={8}
                maxLength={8}
                autoComplete="one-time-code"
                required
              />
            </Field>
            <MagneticButton className="btn btn-primary" disabled={pending} type="submit">
              Approve device
            </MagneticButton>
          </form>
        </Panel>

        <Panel eyebrow="Non-interactive pull" title="Automation token" icon={KeyRound}>
          <form className="stack" onSubmit={(event) => void createAutomation(event)}>
            <p className="muted">Long-lived and full pull scope. The plaintext is shown once.</p>
            <Field label="Label">
              <input name="label" placeholder="Home CI" required />
            </Field>
            <MagneticButton className="btn btn-primary" disabled={pending} type="submit">
              Create token
            </MagneticButton>
          </form>
        </Panel>
      </div>

      {error !== undefined && <ErrorNotice error={error} />}

      {oneTimeToken && (
        <motion.section
          className="one-time-token"
          role="alert"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
        >
          <div>
            <p className="eyebrow">Shown once</p>
            <h2>Copy this token now</h2>
          </div>
          <code>{oneTimeToken}</code>
          <button
            className="btn"
            onClick={() => void navigator.clipboard.writeText(oneTimeToken)}
            type="button"
          >
            <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
            Copy
          </button>
          <button className="btn" onClick={() => setOneTimeToken(undefined)} type="button">
            Clear
          </button>
        </motion.section>
      )}

      <div className="table">
        <div className="table-head token-columns">
          <span>Label</span>
          <span>Kind</span>
          <span>Prefix</span>
          <span>Last used</span>
          <span>Action</span>
        </div>
        {tokens.data?.map((token) => (
          <div className="table-row token-columns" key={token.id}>
            <strong>{token.label}</strong>
            <span>{token.kind}</span>
            <code>{token.prefix}</code>
            <span>{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}</span>
            <button
              className="btn btn-danger"
              disabled={token.revokedAt !== null}
              onClick={() => void revoke(token.id)}
              type="button"
            >
              {token.revokedAt ? (
                "Revoked"
              ) : (
                <>
                  <Ban size={15} strokeWidth={1.5} aria-hidden="true" />
                  Revoke
                </>
              )}
            </button>
          </div>
        ))}
      </div>
    </Page>
  );
}

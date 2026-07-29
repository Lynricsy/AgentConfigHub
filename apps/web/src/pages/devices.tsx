import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { TokenList, api, mutate, mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";

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

  return <div className="page-frame">
    <header className="page-header"><div><p className="eyebrow">Pull-only access</p><h1>Devices & tokens</h1><p>Approve pairing codes, issue automation credentials, and revoke access immediately.</p></div></header>
    <div className="two-column">
      <form className="panel action-card stack" onSubmit={(event) => void approve(event)}><p className="eyebrow">Device pairing</p><h2>Approve user code</h2><p className="muted">Compare this code with the CLI before approval.</p><label>Eight-character code<input name="userCode" minLength={8} maxLength={8} autoComplete="one-time-code" required /></label><button className="primary" disabled={pending}>Approve device</button></form>
      <form className="panel action-card stack" onSubmit={(event) => void createAutomation(event)}><p className="eyebrow">Non-interactive pull</p><h2>Automation token</h2><p className="muted">Long-lived and full pull scope. The plaintext is shown once.</p><label>Label<input name="label" placeholder="Home CI" required /></label><button className="primary" disabled={pending}>Create token</button></form>
    </div>
    {error !== undefined && <ErrorNotice error={error} />}
    {oneTimeToken && <section className="one-time-token panel" role="alert"><div><p className="eyebrow">Shown once</p><h2>Copy this token now</h2></div><code>{oneTimeToken}</code><button onClick={() => void navigator.clipboard.writeText(oneTimeToken)}>Copy</button><button onClick={() => setOneTimeToken(undefined)}>Clear</button></section>}
    <div className="table panel"><div className="table-head token-columns"><span>Label</span><span>Kind</span><span>Prefix</span><span>Last used</span><span /></div>{tokens.data?.map((token) => <div className="table-row token-columns" key={token.id}><strong>{token.label}</strong><span>{token.kind}</span><code>{token.prefix}</code><span>{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}</span><button className="danger" disabled={token.revokedAt !== null} onClick={() => void revoke(token.id)}>{token.revokedAt ? "Revoked" : "Revoke"}</button></div>)}</div>
  </div>;
}

import { useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = {
      currentPassword: String(data.get("currentPassword")),
      newPassword: String(data.get("newPassword")),
      revokePullTokens: data.get("revokePullTokens") === "on",
    };
    form.reset(); setPending(true); setError(undefined);
    try {
      await mutateEmpty("/api/v1/password", input);
      queryClient.clear();
      navigate("/login", { replace: true });
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  return <div className="page-frame">
    <header className="page-header"><div><p className="eyebrow">Control plane</p><h1>Settings</h1><p>Security boundaries for this single-instance deployment.</p></div></header>
    <div className="two-column settings-layout">
      <form className="panel action-card stack" onSubmit={(event) => void changePassword(event)}><p className="eyebrow">Administrator</p><h2>Change password</h2><label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>New password<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><label className="check"><input name="revokePullTokens" type="checkbox" />Revoke every device and automation token</label>{error !== undefined && <ErrorNotice error={error} />}<button className="primary" disabled={pending}>Change password & sign out</button></form>
      <section className="panel action-card"><p className="eyebrow">Security posture</p><h2>Storage & delivery</h2><dl><dt>Browser cache</dt><dd>No-store; no persistence</dd><dt>Credential values</dt><dd>Envelope encrypted</dd><dt>Device access</dt><dd>Pull-only bearer tokens</dd><dt>Release outputs</dt><dd>Immutable encrypted blobs</dd><dt>Mutation control</dt><dd>Origin + If-Match</dd></dl></section>
    </div>
  </div>;
}

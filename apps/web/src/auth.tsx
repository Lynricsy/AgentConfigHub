import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { ApiClientError, api, mutateEmpty } from "./api.js";

const SetupState = z.object({ required: z.boolean() });
const Session = z.object({ authenticated: z.literal(true) });

function AuthFrame({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return <main className="auth-page">
    <section className="auth-brand">
      <div className="brand-mark" aria-hidden="true">A</div>
      <p className="eyebrow">AgentConfigHub</p>
      <h1>One source.<br />Every agent.</h1>
      <p>Securely version and distribute native configuration without surrendering control of your secrets.</p>
    </section>
    <section className="auth-panel">
      <div className="auth-card">
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  </main>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api("/api/v1/setup", SetupState), retry: false });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api("/api/v1/session", Session),
    enabled: setup.data?.required === false,
    retry: false,
  });
  if (setup.isPending || (setup.data?.required === false && session.isPending)) {
    return <div className="center-state"><span className="spinner" />Checking control plane…</div>;
  }
  if (setup.data?.required) return <Navigate to="/setup" replace />;
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api("/api/v1/setup", SetupState), retry: false });
  if (setup.data?.required === false) return <Navigate to="/login" replace />;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = { setupCode: String(data.get("setupCode")), password: String(data.get("password")) };
    form.reset(); setPending(true); setError(undefined);
    try {
      await mutateEmpty("/api/v1/setup", input);
      await queryClient.invalidateQueries({ queryKey: ["setup"] });
      navigate("/login", { replace: true });
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  return <AuthFrame kicker="First run" title="Initialize your control plane">
    <p className="muted">Enter the one-time setup code printed in the server logs, then choose an administrator password.</p>
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <label>Setup code<input name="setupCode" autoComplete="one-time-code" required /></label>
      <label>Administrator password<input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
      {error !== undefined && <ErrorNotice error={error} />}
      <button className="primary" disabled={pending}>{pending ? "Initializing…" : "Initialize"}</button>
    </form>
  </AuthFrame>;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password"));
    form.reset(); setPending(true); setError(undefined);
    try {
      await mutateEmpty("/api/v1/login", { password });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      const state = location.state;
      const destination = state && typeof state === "object" && "from" in state && typeof state.from === "string"
        ? state.from
        : "/config-sets";
      navigate(destination, { replace: true });
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  return <AuthFrame kicker="Administrator" title="Welcome back">
    <p className="muted">Sign in to edit drafts, manage credentials, and publish immutable releases.</p>
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <label>Password<input name="password" type="password" autoComplete="current-password" required autoFocus /></label>
      {error !== undefined && <ErrorNotice error={error} />}
      <button className="primary" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  </AuthFrame>;
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof ApiClientError ? `${error.message} · ${error.requestId}` : "The request could not be completed.";
  return <div className="notice error" role="alert">{message}</div>;
}

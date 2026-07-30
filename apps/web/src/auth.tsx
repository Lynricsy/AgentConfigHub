import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { TriangleAlert, Zap } from "lucide-react";
import { z } from "zod";

import { AgentId } from "@agent-config-hub/protocol";

import { ApiClientError, api, mutateEmpty } from "./api.js";
import { KineticTitle } from "./fx/kinetic-title.js";
import { Field, Loading } from "./ui/bits.js";
import { MagneticButton } from "./ui/magnetic.js";

const SetupState = z.object({ required: z.boolean() });
const Session = z.object({ authenticated: z.literal(true) });

/* ── AuthStage ──────────────────────────────────────────────────────── */

const marqueeText = AgentId.options.map((id) => id.toUpperCase()).join(" · ");

function AuthStage({ kicker, title, children }: {
  kicker: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <main className="auth-stage">
      <div className="auth-art">
        <div className="auth-art-icon">
          <Zap size={22} strokeWidth={1.5} aria-hidden="true" />
        </div>
        <p className="eyebrow">AGENTCONFIGHUB</p>
        <KineticTitle text="ONE SOURCE" className="display" />
        <KineticTitle text="EVERY AGENT" className="display display-outline auth-art-extra" />
        <p className="auth-art-desc auth-art-extra">
          Securely version and distribute native configuration without surrendering control of your secrets.
        </p>
        <div className="auth-marquee" aria-hidden="true">
          <span className="auth-marquee-inner">
            {marqueeText} · {marqueeText} · 
          </span>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">{kicker}</p>
          <h2 className="display-sm">{title}</h2>
          {children}
        </div>
      </div>
    </main>
  );
}

/* ── AuthGate ───────────────────────────────────────────────────────── */

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api("/api/v1/setup", SetupState), retry: false });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api("/api/v1/session", Session),
    enabled: setup.data?.required === false,
    retry: false,
  });
  if (setup.isPending || (setup.data?.required === false && session.isPending)) {
    return <Loading label="Checking control plane…" />;
  }
  if (setup.data?.required) return <Navigate to="/setup" replace />;
  if (!session.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

/* ── SetupPage ──────────────────────────────────────────────────────── */

export function SetupPage(): ReactElement {
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
  return (
    <AuthStage kicker="First run" title="Initialize your control plane">
      <p className="muted">Enter the one-time setup code printed in the server logs, then choose an administrator password.</p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <Field label="Setup code">
          <input name="setupCode" autoComplete="one-time-code" required />
        </Field>
        <Field label="Administrator password">
          <input name="password" type="password" minLength={12} autoComplete="new-password" required />
        </Field>
        {error !== undefined && <ErrorNotice error={error} />}
        <MagneticButton className="btn btn-primary" disabled={pending} type="submit">
          {pending ? "Initializing…" : "Initialize"}
        </MagneticButton>
      </form>
    </AuthStage>
  );
}

/* ── LoginPage ──────────────────────────────────────────────────────── */

export function LoginPage(): ReactElement {
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
  return (
    <AuthStage kicker="Administrator" title="Welcome back">
      <p className="muted">Sign in to edit drafts, manage credentials, and publish immutable releases.</p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required autoFocus />
        </Field>
        {error !== undefined && <ErrorNotice error={error} />}
        <MagneticButton className="btn btn-primary" disabled={pending} type="submit">
          {pending ? "Signing in…" : "Sign in"}
        </MagneticButton>
      </form>
    </AuthStage>
  );
}

/* ── ErrorNotice ────────────────────────────────────────────────────── */

export function ErrorNotice({ error }: { error: unknown }): ReactElement {
  const message = error instanceof ApiClientError
    ? `${error.message} · ${error.requestId}`
    : "The request could not be completed.";
  return (
    <div className="notice notice-error" role="alert">
      <TriangleAlert size={15} strokeWidth={1.5} aria-hidden="true" />
      {message}
    </div>
  );
}

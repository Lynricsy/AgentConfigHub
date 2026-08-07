import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent, ReactElement, ReactNode } from "react";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { TriangleAlert, Zap } from "lucide-react";
import { z } from "zod";

import { ApiClientError, api, mutateEmpty } from "./api.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardHeader } from "./ui/card.js";
import { Field } from "./ui/field.js";
import { Input } from "./ui/input.js";
import { Loading } from "./ui/spinner.js";

const SetupState = z.object({ required: z.boolean() });
const Session = z.object({ authenticated: z.literal(true) });

/* ── AuthStage ──────────────────────────────────────────────────────── */

function AuthStage({ kicker, title, children }: {
  kicker: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Zap className="size-5 text-primary" aria-hidden="true" />
            <span>AgentConfigHub</span>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{kicker}</p>
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
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
  if (!session.data) {
    // 带上 search,否则 CLI 的 /devices/approve?code=… 深链在登录后会丢失 code
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
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
      <p className="text-sm text-muted-foreground">Enter the one-time setup code printed in the server logs, then choose an administrator password.</p>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <Field label="Setup code">
          <Input name="setupCode" autoComplete="one-time-code" required />
        </Field>
        <Field label="Administrator password">
          <Input name="password" type="password" minLength={12} autoComplete="new-password" required />
        </Field>
        {error !== undefined && <ErrorNotice error={error} />}
        <Button disabled={pending} type="submit">
          {pending ? "Initializing…" : "Initialize"}
        </Button>
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
      <p className="text-sm text-muted-foreground">Sign in to edit drafts, manage credentials, and publish immutable releases.</p>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required autoFocus />
        </Field>
        {error !== undefined && <ErrorNotice error={error} />}
        <Button disabled={pending} type="submit">
          {pending ? "Signing in…" : "Sign in"}
        </Button>
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
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      role="alert"
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}

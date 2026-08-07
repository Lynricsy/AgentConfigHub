import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { HardDrive, Lock, Shield } from "lucide-react";

import { api, mutate, mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Field, Panel } from "../ui/bits.js";
import { MagneticButton } from "../ui/magnetic.js";
import { Page } from "../ui/page.js";

const StorageStats = z.object({
  blobs: z.number().int().nonnegative(),
  plaintextBytes: z.number().int().nonnegative(),
  unreferencedBlobs: z.number().int().nonnegative(),
});
const GcResult = z.object({
  scanned: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

export function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [gcPending, setGcPending] = useState(false);
  const [gcResult, setGcResult] = useState<z.infer<typeof GcResult>>();
  const [gcError, setGcError] = useState<unknown>();
  const storage = useQuery({
    queryKey: ["storage"],
    queryFn: () => api("/api/v1/storage", StorageStats),
  });
  const runGc = async () => {
    setGcPending(true); setGcError(undefined);
    try {
      const result = await mutate("/api/v1/storage/gc", GcResult, {});
      setGcResult(result.data);
      await queryClient.invalidateQueries({ queryKey: ["storage"] });
    } catch (cause) { setGcError(cause); }
    finally { setGcPending(false); }
  };
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
  return (
    <Page
      title="Settings"
      lede="Security boundaries for this single-instance deployment."
    >
      <div className="card-grid settings-layout">
        <Panel eyebrow="Administrator" title="Change password" icon={Lock}>
          <form className="stack" onSubmit={(event) => void changePassword(event)}>
            <Field label="Current password">
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="New password">
              <input
                name="newPassword"
                type="password"
                minLength={12}
                autoComplete="new-password"
                required
              />
            </Field>
            <label className="check">
              <input name="revokePullTokens" type="checkbox" />
              Revoke every device and automation token
            </label>
            {error !== undefined && <ErrorNotice error={error} />}
            <MagneticButton
              className="btn btn-primary"
              disabled={pending}
              type="submit"
            >
              Change password & sign out
            </MagneticButton>
          </form>
        </Panel>

        <Panel eyebrow="Security posture" title="Storage & delivery" icon={Shield}>
          <dl className="mono">
            <dt>Browser cache</dt>
            <dd>No-store; no persistence</dd>
            <dt>Credential values</dt>
            <dd>Envelope encrypted</dd>
            <dt>Device access</dt>
            <dd>Pull-only bearer tokens</dd>
            <dt>Release outputs</dt>
            <dd>Immutable encrypted blobs</dd>
            <dt>Mutation control</dt>
            <dd>Origin + If-Match</dd>
          </dl>
        </Panel>

        <Panel eyebrow="Maintenance" title="Encrypted Blob storage" icon={HardDrive}>
          {storage.data ? (
            <dl className="mono">
              <dt>Blobs</dt>
              <dd className="display-sm mono">{storage.data.blobs}</dd>
              <dt>Plaintext bytes</dt>
              <dd className="display-sm mono">
                {storage.data.plaintextBytes.toLocaleString()}
              </dd>
              <dt>Unreferenced</dt>
              <dd className="display-sm mono">{storage.data.unreferencedBlobs}</dd>
            </dl>
          ) : (
            <p className="muted">Loading storage statistics...</p>
          )}
          {gcResult && (
            <div className="notice notice-ok">
              Scanned {gcResult.scanned}; deleted {gcResult.deleted} beyond the seven-day grace
              period.
            </div>
          )}
          {gcError !== undefined && <ErrorNotice error={gcError} />}
          <button className="btn" disabled={gcPending} onClick={() => void runGc()}>
            {gcPending ? "Running GC..." : "Run Blob GC"}
          </button>
        </Panel>
      </div>
    </Page>
  );
}

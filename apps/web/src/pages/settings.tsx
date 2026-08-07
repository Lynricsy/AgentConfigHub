import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Lock, Shield } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { api, mutate, mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { Checkbox } from "../ui/checkbox.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
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
  const [revokePullTokens, setRevokePullTokens] = useState(false);
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
      toast.success(`Blob GC complete: scanned ${result.data.scanned}, deleted ${result.data.deleted}`);
      await queryClient.invalidateQueries({ queryKey: ["storage"] });
    } catch (cause) {
      setGcError(cause);
      toast.error("Blob GC failed");
    }
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
    form.reset(); setRevokePullTokens(false); setPending(true); setError(undefined);
    try {
      await mutateEmpty("/api/v1/password", input);
      toast.success("Password changed");
      queryClient.clear();
      navigate("/login", { replace: true });
    } catch (cause) {
      setError(cause);
      toast.error("Password change failed");
    }
    finally { setPending(false); }
  };
  return (
    <Page
      title="Settings"
      lede="Security boundaries for this single-instance deployment."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
              Change password
            </CardTitle>
            <CardDescription>Administrator</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="max-w-xl space-y-4"
              onSubmit={(event) => void changePassword(event)}
            >
              <Field label="Current password">
                <Input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Field label="New password">
                <Input
                  name="newPassword"
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={revokePullTokens}
                  name="revokePullTokens"
                  onCheckedChange={(checked) => setRevokePullTokens(checked === true)}
                />
                Revoke every device and automation token
              </label>
              {error !== undefined && <ErrorNotice error={error} />}
              <Button disabled={pending} type="submit">
                Change password & sign out
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4 text-muted-foreground" aria-hidden="true" />
              Storage & delivery
            </CardTitle>
            <CardDescription>Security posture</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Browser cache</dt>
              <dd className="font-mono">No-store; no persistence</dd>
              <dt className="text-muted-foreground">Credential values</dt>
              <dd className="font-mono">Envelope encrypted</dd>
              <dt className="text-muted-foreground">Device access</dt>
              <dd className="font-mono">Pull-only bearer tokens</dd>
              <dt className="text-muted-foreground">Release outputs</dt>
              <dd className="font-mono">Immutable encrypted blobs</dd>
              <dt className="text-muted-foreground">Mutation control</dt>
              <dd className="font-mono">Origin + If-Match</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />
              Encrypted Blob storage
            </CardTitle>
            <CardDescription>Maintenance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {storage.data ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-muted-foreground">Blobs</dt>
                <dd className="font-mono">{storage.data.blobs}</dd>
                <dt className="text-muted-foreground">Plaintext bytes</dt>
                <dd className="font-mono">
                  {storage.data.plaintextBytes.toLocaleString()}
                </dd>
                <dt className="text-muted-foreground">Unreferenced</dt>
                <dd className="font-mono">{storage.data.unreferencedBlobs}</dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Loading storage statistics...</p>
            )}
            {gcResult && (
              <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs font-mono">
                Scanned {gcResult.scanned}; deleted {gcResult.deleted} beyond the seven-day grace
                period.
              </div>
            )}
            {gcError !== undefined && <ErrorNotice error={gcError} />}
            <Button
              variant="outline"
              disabled={gcPending}
              onClick={() => void runGc()}
            >
              {gcPending ? "Running GC..." : "Run Blob GC"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

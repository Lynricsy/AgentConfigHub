import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Ban, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";

import { TokenList, api, mutate, mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";
import { Empty } from "../ui/empty.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { Page } from "../ui/page.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";

const AutomationToken = z.object({ id: z.string(), token: z.string(), prefix: z.string() });

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [oneTimeToken, setOneTimeToken] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [revokeTokenId, setRevokeTokenId] = useState<string>();
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
    try {
      await mutateEmpty("/api/v1/devices/approve", { userCode });
      toast.success("Device approved");
    } catch (cause) {
      setError(cause);
      toast.error("Failed to approve device");
    } finally {
      setPending(false);
    }
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
      toast.success("Automation token created");
    } catch (cause) {
      setError(cause);
      toast.error("Failed to create automation token");
    } finally {
      setPending(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await mutateEmpty(`/api/v1/tokens/${id}`, {}, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setRevokeTokenId(undefined);
      toast.success("Token revoked");
    } catch (cause) {
      setError(cause);
      toast.error("Failed to revoke token");
    }
  };

  return (
    <Page
      title="Devices & tokens"
      lede="Approve pairing codes, issue automation credentials, and revoke access immediately."
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              Approve user code
            </CardTitle>
            <CardDescription>Device pairing</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={(event) => void approve(event)}>
              <p className="text-sm text-muted-foreground">Compare this code with the CLI before approval.</p>
              <Field label="Eight-character code">
                <Input
                  className="font-mono uppercase tracking-[0.18em]"
                  name="userCode"
                  minLength={8}
                  maxLength={8}
                  autoComplete="one-time-code"
                  required
                />
              </Field>
              <Button className="self-start" disabled={pending} type="submit">
                Approve device
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" aria-hidden="true" />
              Automation token
            </CardTitle>
            <CardDescription>Non-interactive pull</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={(event) => void createAutomation(event)}>
              <p className="text-sm text-muted-foreground">
                Long-lived and full pull scope. The plaintext is shown once.
              </p>
              <Field label="Label">
                <Input name="label" placeholder="Home CI" required />
              </Field>
              <Button className="self-start" disabled={pending} type="submit">
                Create token
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {error !== undefined && <ErrorNotice error={error} />}

      {oneTimeToken && (
        <section
          className="one-time-token flex flex-col gap-3 rounded-lg border border-success/35 bg-success/10 p-4"
          role="alert"
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-success">Shown once</p>
            <h2 className="mt-1 text-sm font-semibold">Copy this token now</h2>
          </div>
          <code
            data-testid="one-time-token"
            className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
          >
            {oneTimeToken}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(oneTimeToken)}
              type="button"
            >
              <Copy aria-hidden="true" />
              Copy
            </Button>
            <Button variant="ghost" onClick={() => setOneTimeToken(undefined)} type="button">
              Clear
            </Button>
          </div>
        </section>
      )}

      {tokens.data?.length === 0 ? (
        <Empty title="No device or automation tokens" hint="Approve a device or create an automation token to begin." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data?.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">{token.label}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{token.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{token.prefix}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Dialog
                      open={revokeTokenId === token.id}
                      onOpenChange={(open) => setRevokeTokenId(open ? token.id : undefined)}
                    >
                      <DialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={token.revokedAt !== null}
                          type="button"
                        >
                          {token.revokedAt ? (
                            "Revoked"
                          ) : (
                            <>
                              <Ban aria-hidden="true" />
                              Revoke
                            </>
                          )}
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Revoke token</DialogTitle>
                          <DialogDescription>
                            This token will immediately lose access. This action cannot be undone.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <DialogClose asChild>
                            <Button variant="ghost">Cancel</Button>
                          </DialogClose>
                          <Button variant="destructive" onClick={() => void revoke(token.id)}>
                            Revoke token
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}

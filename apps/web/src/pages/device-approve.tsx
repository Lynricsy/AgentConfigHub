import type { FormEvent } from "react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { mutateEmpty } from "../api.js";
import { ErrorNotice } from "../auth.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";

const DEVICE_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
type ApprovalStatus = "idle" | "pending" | "approved" | "error";

export function DeviceApprovePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const linkedCode = searchParams.get("code");
  const normalizedLinkedCode = linkedCode?.toUpperCase() ?? "";
  const malformedLinkedCode = linkedCode !== null && !DEVICE_CODE.test(normalizedLinkedCode);
  const [userCode, setUserCode] = useState(
    DEVICE_CODE.test(normalizedLinkedCode) ? normalizedLinkedCode : "",
  );
  const [status, setStatus] = useState<ApprovalStatus>("idle");
  const [error, setError] = useState<unknown>();

  const approve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("pending");
    setError(undefined);
    try {
      await mutateEmpty("/api/v1/devices/approve", { userCode });
      setStatus("approved");
    } catch (cause) {
      setError(cause);
      setStatus("error");
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Approve device</CardTitle>
          {status !== "approved" && (
            <CardDescription>
              A CLI requested access with this code. Approving mints a pull-only device token.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {status === "approved" ? (
            <div className="flex flex-col items-start gap-4">
              <Badge variant="success">Approved</Badge>
              <p className="text-sm text-muted-foreground">
                Device approved. Return to your terminal — the CLI polls every 5 seconds and will receive its token
                automatically.
              </p>
              <Button onClick={() => navigate("/devices")}>View device tokens</Button>
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={(event) => void approve(event)}>
              <Field label="Device code">
                <Input
                  className="font-mono text-lg uppercase tracking-[0.35em]"
                  name="userCode"
                  maxLength={8}
                  required
                  value={userCode}
                  onChange={(event) => setUserCode(event.target.value.toUpperCase())}
                />
                {malformedLinkedCode && (
                  <span className="text-xs text-warning">
                    The code in the link is malformed — enter it manually
                  </span>
                )}
              </Field>
              {status === "error" && error !== undefined && <ErrorNotice error={error} />}
              <div className="flex flex-wrap gap-2">
                <Button disabled={status === "pending"} type="submit">
                  Approve device
                </Button>
                <Button variant="ghost" onClick={() => navigate("/devices")}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

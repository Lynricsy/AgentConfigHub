import { Toaster as Sonner } from "sonner";
import type { ReactElement } from "react";

import { useTheme } from "../theme.js";

export function Toaster(): ReactElement {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "!rounded-md !border !border-border !bg-popover !text-popover-foreground !shadow-lg",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-secondary !text-secondary-foreground",
        },
      }}
    />
  );
}

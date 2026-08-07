import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Link, useLocation, useNavigate, useOutlet } from "react-router-dom";
import {
  BookOpen,
  Cpu,
  KeyRound,
  Layers,
  LogOut,
  Monitor,
  Moon,
  PackageCheck,
  Settings2,
  ShieldAlert,
  Sun,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ConfigSetList, api, mutateEmpty } from "./api.js";
import { cn } from "./lib/cn.js";
import { useTheme } from "./theme.js";
import type { Theme } from "./theme.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

/* ── Status context (signature unchanged — config-editor depends on it) ── */

interface StatusContextValue {
  blockingDiagnostics: number;
  setBlockingDiagnostics: (count: number) => void;
}

const StatusContext = createContext<StatusContextValue | null>(null);

export function useAppStatus(): StatusContextValue {
  const value = useContext(StatusContext);
  if (!value) throw new Error("App status is unavailable outside the shell.");
  return value;
}

/* ── Navigation ────────────────────────────────────────────────────────── */

const navigation: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/config-sets",  label: "Configuration", icon: Layers },
  { to: "/resources",    label: "Resources",     icon: BookOpen },
  { to: "/credentials",  label: "Credentials",   icon: KeyRound },
  { to: "/releases",     label: "Releases",      icon: PackageCheck },
  { to: "/devices",      label: "Devices",       icon: Cpu },
  { to: "/settings",     label: "Settings",      icon: Settings2 },
];

/* ── Theme toggle ──────────────────────────────────────────────────────── */

const themeCycle: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const themeIcon: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

function ThemeToggle(): ReactElement {
  const { theme, setTheme } = useTheme();
  const Icon = themeIcon[theme];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setTheme(themeCycle[theme])}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Theme: {theme}</TooltipContent>
    </Tooltip>
  );
}

/* ── Status meter ──────────────────────────────────────────────────────── */

function Meter({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/* ── AppShell ───────────────────────────────────────────────────────────── */

export function AppShell(): ReactElement {
  const [blockingDiagnostics, setBlockingDiagnostics] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const outlet = useOutlet();

  // ── data (unchanged) ────────────────────────────────────────────────────
  const configSets = useQuery({
    queryKey: ["config-sets"],
    queryFn: () => api("/api/v1/config-sets", ConfigSetList),
  });
  const selectedId = /^\/config-sets\/([^/]+)/.exec(location.pathname)?.[1];
  const selected = configSets.data?.find(({ id }) => id === selectedId);
  const statusConfig = selected ?? configSets.data?.[0];
  const dirtyCount = configSets.data?.filter(({ draftRevision, currentReleaseRevision }) => (
    currentReleaseRevision === null || currentReleaseRevision !== draftRevision
  )).length ?? 0;
  const logout = useMutation({
    mutationFn: () => mutateEmpty("/api/v1/logout", {}),
    onSuccess: () => {
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });
  const status = useMemo(() => ({ blockingDiagnostics, setBlockingDiagnostics }), [blockingDiagnostics]);

  return (
    <StatusContext.Provider value={status}>
      <TooltipProvider delayDuration={250}>
        <div className="grid h-screen grid-cols-[240px_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-[56px_1fr]">

          {/* ── Rail ─────────────────────────────────────────────────────── */}
          <aside className="flex min-h-0 flex-col border-r border-border bg-card">
            <Link
              to="/config-sets"
              className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4 max-[900px]:justify-center max-[900px]:px-0"
            >
              <Zap className="size-5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden="true" />
              <span className="flex flex-col leading-tight max-[900px]:hidden">
                <strong className="text-sm font-semibold tracking-tight">AgentConfigHub</strong>
                <small className="text-[0.6875rem] text-muted-foreground">Control plane</small>
              </span>
            </Link>

            <nav className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Main navigation">
              {navigation.map(({ to, label, icon: Icon }) => {
                // 自算 active:Radix Slot 会把 NavLink 的函数式 className 拼成字符串,
                // 因此这里必须给出普通字符串 class。
                const active = location.pathname === to || location.pathname.startsWith(`${to}/`);
                return (
                  <Tooltip key={to}>
                    <TooltipTrigger asChild>
                      <Link
                        to={to}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150",
                          "max-[900px]:justify-center max-[900px]:px-0",
                          active
                            ? "bg-primary/12 font-medium text-primary"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                        <span className="truncate max-[900px]:hidden">{label}</span>
                      </Link>
                    </TooltipTrigger>
                    {/* 仅折叠态需要提示,宽屏用 CSS 隐藏,避免额外的尺寸监听 */}
                    <TooltipContent side="right" className="min-[901px]:hidden">{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>

            <div className="flex shrink-0 items-center gap-1 border-t border-border p-2 max-[900px]:flex-col">
              <ThemeToggle />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    className="flex-1 justify-start max-[900px]:size-9 max-[900px]:flex-none max-[900px]:justify-center max-[900px]:px-0"
                    onClick={() => logout.mutate()}
                    disabled={logout.isPending}
                  >
                    <LogOut aria-hidden="true" />
                    <span className="max-[900px]:hidden">Sign out</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="min-[901px]:hidden">Sign out</TooltipContent>
              </Tooltip>
            </div>
          </aside>

          {/* ── Workspace ────────────────────────────────────────────────── */}
          <section className="flex min-h-0 min-w-0 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-5">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <Meter label="Drafts">
                  <Badge variant={dirtyCount > 0 ? "warning" : "outline"}>{dirtyCount}</Badge>
                </Meter>
                <Meter label="Release">
                  <Badge variant="outline" className="font-mono">
                    {statusConfig?.currentReleaseNumber ? `r${statusConfig.currentReleaseNumber}` : "—"}
                  </Badge>
                </Meter>
                <Meter label="Blocking">
                  <Badge variant={blockingDiagnostics > 0 ? "destructive" : "outline"}>
                    {blockingDiagnostics > 0 && <ShieldAlert aria-hidden="true" />}
                    {blockingDiagnostics}
                  </Badge>
                </Meter>
              </div>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {statusConfig?.name ?? "Administration"}
              </p>
            </header>

            <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{outlet}</main>
          </section>

        </div>
      </TooltipProvider>
    </StatusContext.Provider>
  );
}

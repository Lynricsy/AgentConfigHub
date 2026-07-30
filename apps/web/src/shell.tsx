import Lenis from "lenis";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useOutlet } from "react-router-dom";
import {
  BookOpen,
  Cpu,
  KeyRound,
  Layers,
  LogOut,
  PackageCheck,
  Radio,
  Settings2,
  ShieldAlert,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ConfigSetList, api, mutateEmpty } from "./api.js";
import { KineticTitle } from "./fx/kinetic-title.js";
import { RouteTransition } from "./ui/page.js";

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

/* ── Counter — flips number with spring animation ──────────────────────── */

function Counter({ value, className }: { value: string; className?: string | undefined }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={value}
        className={className}
        initial={{ y: -8, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 8, opacity: 0 }}
        transition={{ duration: 0.18 }}
      >
        {value}
      </motion.span>
    </AnimatePresence>
  );
}

/* ── AppShell ───────────────────────────────────────────────────────────── */

export function AppShell() {
  const [blockingDiagnostics, setBlockingDiagnostics] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const outlet = useOutlet();
  const reduceMotion = useReducedMotion();

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

  // ── Lenis smooth scroll (migrated from main.tsx) ────────────────────────
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content || reduceMotion) return;
    const lenis = new Lenis({ wrapper, content });
    let frame = requestAnimationFrame(function tick(time: number) {
      lenis.raf(time);
      frame = requestAnimationFrame(tick);
    });
    return () => { cancelAnimationFrame(frame); lenis.destroy(); };
  }, [reduceMotion]);

  return (
    <StatusContext.Provider value={status}>
      <div className="app-shell">

        {/* ── Rail ─────────────────────────────────────────────────────── */}
        <aside className="rail">
          <NavLink to="/config-sets" className="rail-brand">
            <Zap size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>
              <strong>AgentConfigHub</strong>
              <small>Control plane</small>
            </span>
          </NavLink>

          <nav className="rail-nav" aria-label="Main navigation">
            {navigation.map((item, i) => {
              const Icon = item.icon;
              const idx = String(i + 1).padStart(2, "0");
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => isActive ? "rail-link active" : "rail-link"}
                >
                  {({ isActive }) => <>
                    {isActive && (
                      <motion.span
                        layoutId="rail-active"
                        className="rail-active"
                        transition={{ type: "spring", stiffness: 320, damping: 30 }}
                      />
                    )}
                    <span className="rail-index" aria-hidden="true">{idx}</span>
                    <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
                    <span className="rail-label">{item.label}</span>
                  </>}
                </NavLink>
              );
            })}
          </nav>

          <div className="rail-foot">
            <div className="rail-foot-status">
              <Radio size={13} strokeWidth={1.5} aria-hidden="true" />
              <span>Server connected</span>
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={13} strokeWidth={1.5} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </aside>

        {/* ── Workspace ────────────────────────────────────────────────── */}
        <section className="workspace">

          {/* ── Telemetry bar ──────────────────────────────────────────── */}
          <header className="telemetry">
            <div className="telemetry-meters">
              <div className="telemetry-meter">
                <label>DRAFTS</label>
                <span className="value" style={dirtyCount > 0 ? { color: "var(--warn)" } : undefined}>
                  <Counter value={String(dirtyCount)} />
                </span>
              </div>
              <div className="telemetry-meter">
                <label>RELEASE</label>
                <span className="value">
                  <Counter value={statusConfig?.currentReleaseNumber ? `r${statusConfig.currentReleaseNumber}` : "—"} />
                </span>
              </div>
              <div className="telemetry-meter">
                <label>BLOCKING</label>
                <span className="value" style={blockingDiagnostics > 0 ? { color: "var(--danger)" } : undefined}>
                  {blockingDiagnostics > 0 && <ShieldAlert size={11} strokeWidth={1.5} aria-hidden="true" />}
                  <Counter value={String(blockingDiagnostics)} />
                </span>
              </div>
            </div>
            <KineticTitle
              text={statusConfig?.name ?? "Administration"}
              className="mono"
            />
          </header>

          {/* ── Route content + Lenis wrapper ──────────────────────────── */}
          <div className="route-content" ref={wrapperRef}>
            <div className="route-scroll-content" ref={contentRef}>
              <AnimatePresence mode="wait" initial={false}>
                <RouteTransition key={location.pathname}>
                  {outlet}
                </RouteTransition>
              </AnimatePresence>
            </div>
          </div>
        </section>

      </div>
    </StatusContext.Provider>
  );
}

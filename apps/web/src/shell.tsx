import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";

import { ConfigSetList, api, mutateEmpty } from "./api.js";

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

const navigation = [
  { to: "/config-sets", label: "Configuration", mark: "CF" },
  { to: "/resources", label: "Resources", mark: "RS" },
  { to: "/credentials", label: "Credentials", mark: "CR" },
  { to: "/releases", label: "Releases", mark: "RL" },
  { to: "/devices", label: "Devices", mark: "DV" },
  { to: "/settings", label: "Settings", mark: "ST" },
] as const;

export function AppShell() {
  const [blockingDiagnostics, setBlockingDiagnostics] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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

  return <StatusContext.Provider value={status}>
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/config-sets" className="logo">
          <span className="brand-mark compact">A</span>
          <span><strong>AgentConfigHub</strong><small>Control plane</small></span>
        </NavLink>
        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? "active" : ""}>
            <span className="nav-mark">{item.mark}</span><span>{item.label}</span>
          </NavLink>)}
        </nav>
        <div className="sidebar-foot">
          <span className="health-dot" /> Server connected
          <button className="text-button" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
        </div>
      </aside>
      <section className="workspace">
        <header className="status-bar">
          <div>
            <span className={dirtyCount ? "status-chip warning" : "status-chip"}>{dirtyCount} dirty</span>
            <span className="status-chip">{statusConfig?.currentReleaseNumber ? `r${statusConfig.currentReleaseNumber}` : "No release"}</span>
            <span className={blockingDiagnostics ? "status-chip danger" : "status-chip"}>{blockingDiagnostics} blocking</span>
          </div>
          <span className="status-context">{statusConfig?.name ?? "Administration"}</span>
        </header>
        <div className="route-content"><Outlet /></div>
      </section>
    </div>
  </StatusContext.Provider>;
}

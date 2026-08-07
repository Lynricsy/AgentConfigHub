import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AuthGate, LoginPage, SetupPage } from "./auth.js";
import { ConfigEditorPage } from "./pages/config-editor.js";
import { ConfigSetListPage } from "./pages/config-set-list.js";
import { CredentialsPage } from "./pages/credentials.js";
import { DevicesPage } from "./pages/devices.js";
import { ReleasesPage } from "./pages/releases.js";
import { SettingsPage } from "./pages/settings.js";
import { ResourcesPage } from "./pages/resources.js";
import { AppShell } from "./shell.js";
import { Toaster } from "./ui/sonner.js";

export function App(): ReactElement {
  return <>
    <Toaster />
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate><AppShell /></AuthGate>}>
        <Route index element={<Navigate to="/config-sets" replace />} />
        <Route path="/config-sets" element={<ConfigSetListPage />} />
        <Route path="/config-sets/:configSetId/configs/:agentId" element={<ConfigEditorPage />} />
        <Route path="/resources" element={<ResourcesPage />} />
        <Route path="/credentials" element={<CredentialsPage />} />
        <Route path="/releases" element={<ReleasesPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/config-sets" replace />} />
    </Routes>
  </>;
}

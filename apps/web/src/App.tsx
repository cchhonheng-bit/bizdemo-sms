import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import Shell from "@/app/Shell";
import { Home, RequireAuth, RequirePerm } from "@/app/guards";
import LoginPage from "@/features/auth/LoginPage";
import FirstLoginPage from "@/features/auth/FirstLoginPage";
import UsersPage from "@/features/users/UsersPage";
import CompanySettingsPage from "@/features/settings/CompanySettingsPage";
import MePage from "@/features/me/MePage";
import DashboardPage from "@/features/dashboard/DashboardPage";
import { Toaster } from "@/components/ui";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } } });

export default function App() {
  const load = useAuth((s) => s.load);
  useEffect(() => { void load(); }, [load]);
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/first-login" element={<FirstLoginPage />} />
            <Route element={<Shell />}>
              <Route index element={<Home />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/tech" element={<DashboardPage />} />
              <Route path="/me" element={<MePage />} />
              <Route element={<RequirePerm perm="user.manage" />}><Route path="/settings/users" element={<UsersPage />} /></Route>
              <Route element={<RequirePerm perm="settings.manage" />}><Route path="/settings/company" element={<CompanySettingsPage />} /></Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

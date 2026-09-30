import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import Shell from "@/app/Shell";
import { Home, RequireAnyPerm, RequireAuth, RequirePerm } from "@/app/guards";
import LoginPage from "@/features/auth/LoginPage";
import FirstLoginPage from "@/features/auth/FirstLoginPage";
import UsersPage from "@/features/users/UsersPage";
import CompanySettingsPage from "@/features/settings/CompanySettingsPage";
import MePage from "@/features/me/MePage";
import DashboardPage from "@/features/dashboard/DashboardPage";
import CustomersPage from "@/features/customers/CustomersPage";
import CatalogPage from "@/features/catalog/CatalogPage";
import BookingsPage from "@/features/bookings/BookingsPage";
import BookingFormPage from "@/features/bookings/BookingFormPage";
import BookingDetailPage from "@/features/bookings/BookingDetailPage";
import TechTodayPage, { TechJobPage } from "@/features/tech/TechTodayPage";
import NotificationsPage from "@/features/notifications/NotificationsPage";
import SubscribePage from "@/features/subscribe/SubscribePage";
import LeavePage from "@/features/leave/LeavePage";
import QuotesPage from "@/features/quotes/QuotesPage";
import QuoteEditorPage from "@/features/quotes/QuoteEditorPage";
import QuotePrintPage from "@/features/quotes/QuotePrintPage";
import InvoicesPage from "@/features/invoices/InvoicesPage";
import InvoiceEditorPage from "@/features/invoices/InvoiceEditorPage";
import InvoiceDetailPage from "@/features/invoices/InvoiceDetailPage";
import InvoicePrintPage from "@/features/invoices/InvoicePrintPage";
import { INVOICE_VIEW } from "@/features/invoices/util";
import AttendancePage from "@/features/attendance/AttendancePage";
import LegalPage from "@/features/legal/LegalPage";
import { RequireFeature } from "@/app/guards";
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
          <Route path="/terms" element={<LegalPage which="terms" />} />
          <Route path="/privacy" element={<LegalPage which="privacy" />} />
          <Route element={<RequireAuth />}>
            <Route path="/first-login" element={<FirstLoginPage />} />
            <Route element={<RequirePerm perm="quote.manage" />}><Route path="/quotes/:id/print" element={<QuotePrintPage />} /></Route>
            <Route element={<RequireAnyPerm perms={INVOICE_VIEW} />}><Route path="/invoices/:id/print" element={<InvoicePrintPage />} /></Route>
            <Route element={<Shell />}>
              <Route index element={<Home />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/bookings" element={<BookingsPage />} />
              <Route element={<RequirePerm perm="booking.create" />}>
                <Route path="/bookings/new" element={<BookingFormPage />} />
                <Route path="/bookings/:id/edit" element={<BookingFormPage />} />
              </Route>
              <Route path="/bookings/:id" element={<BookingDetailPage />} />
              <Route element={<RequirePerm perm="customer.manage" />}><Route path="/customers" element={<CustomersPage />} /></Route>
              <Route element={<RequirePerm perm="catalog.manage" />}><Route path="/catalog" element={<CatalogPage />} /></Route>
              <Route element={<RequireFeature flag="subscribe" />}><Route element={<RequirePerm perm="customer.manage" />}><Route path="/subscribe" element={<SubscribePage />} /></Route></Route>
              <Route path="/tech" element={<TechTodayPage />} />
              <Route path="/tech/job/:id" element={<TechJobPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/leave" element={<LeavePage />} />
              <Route path="/attendance" element={<AttendancePage />} />
              <Route element={<RequirePerm perm="quote.manage" />}>
                <Route path="/quotes" element={<QuotesPage />} />
                <Route path="/quotes/new" element={<QuoteEditorPage />} />
                <Route path="/quotes/:id/edit" element={<QuoteEditorPage />} />
              </Route>
              <Route element={<RequireAnyPerm perms={INVOICE_VIEW} />}>
                <Route path="/invoices" element={<InvoicesPage />} />
                <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
              </Route>
              <Route element={<RequirePerm perm="invoice.issue" />}>
                <Route path="/invoices/new" element={<InvoiceEditorPage />} />
                <Route path="/invoices/:id/edit" element={<InvoiceEditorPage />} />
              </Route>
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

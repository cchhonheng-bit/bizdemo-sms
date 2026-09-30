// Accounting (D-88 · flag "accounting"): reports · money in/out · journal · chart of accounts · payroll · setup (opening, lock).
// Tabs follow permissions; until the opening balances are saved a banner says the books have not started.
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card } from "@/components/ui";
import Reports from "./Reports";
import Money from "./Money";
import Journal from "./Journal";
import Accounts from "./Accounts";
import Payroll from "./Payroll";
import Setup from "./Setup";

type Tab = "reports" | "money" | "journal" | "accounts" | "payroll" | "setup";

export default function AccountingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const view = can("accounting.view"), postP = can("accounting.post"), pay = can("payroll.manage") || can("payroll.approve");
  const [sp, setSp] = useSearchParams();
  const tabs = ([view && "reports", postP && "money", view && "journal", view && "accounts", pay && "payroll", view && "setup"] as (Tab | false)[]).filter((x): x is Tab => !!x);
  const want = sp.get("tab") as Tab | null;
  const tab: Tab = want && tabs.includes(want) ? want : tabs[0] ?? "payroll";
  const go = (k: Tab) => setSp(k === tabs[0] ? {} : { tab: k }, { replace: true });
  const info = useQuery({ queryKey: ["books"], queryFn: api.accounting.info, enabled: view });
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("acct.title")}</h1>
      {view && info.data && !info.data.books_start && tab !== "setup" && (
        <Card className="border-warning" >
          <p className="flex gap-2 items-start text-sm"><AlertTriangle size={18} className="text-warning shrink-0 mt-0.5" /> <span>{t("acct.not_started")}</span></p>
          {can("accounting.close") && <Button variant="primary" className="mt-3 w-full sm:w-auto" onClick={() => go("setup")} data-testid="go-setup">{t("acct.start_books")}</Button>}
        </Card>
      )}
      {tabs.length > 1 && (
        <div className="flex overflow-x-auto rounded-md border border-grey-line text-sm" role="tablist">
          {tabs.map((k) => <button key={k} role="tab" aria-selected={tab === k} data-testid={`tab-${k}`} className={`flex-1 whitespace-nowrap px-3 min-h-[44px] ${tab === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => go(k)}>{t(`acct.tab.${k}`)}</button>)}
        </div>
      )}
      {tab === "reports" ? <Reports /> : tab === "money" ? <Money /> : tab === "journal" ? <Journal /> : tab === "accounts" ? <Accounts />
        : tab === "payroll" ? <Payroll /> : <Setup info={info.data} />}
    </div>
  );
}

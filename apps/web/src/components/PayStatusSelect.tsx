// D-183 (client 28-10): the debt-state filter of every screen and download that lists debts — ទាំងអស់ · ជំពាក់សុទ្ធ · ជំពាក់ខ្លះ · ទូទាត់ហើយ.
// One rule on the server (payStatusOf): nothing paid · paid in part · paid in full.
import { useTranslation } from "react-i18next";
import { PAY_STATUSES, type PayStatus } from "@sms/shared";
import { Field, Select } from "@/components/ui";

export function PayStatusSelect({ value, onChange, only = PAY_STATUSES, testid = "pick-paystatus" }: { value: PayStatus | ""; onChange: (v: PayStatus | "") => void; only?: readonly PayStatus[]; testid?: string }) {
  const { t } = useTranslation();
  return (
    <Field label={t("paystatus.label")}>
      <Select value={value} onChange={(e) => onChange(e.target.value as PayStatus | "")} data-testid={testid}>
        <option value="">{t("paystatus.all")}</option>
        {only.map((s) => <option key={s} value={s}>{t(`paystatus.${s}`)}</option>)}
      </Select>
    </Field>
  );
}

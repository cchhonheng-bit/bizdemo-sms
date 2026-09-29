import { useQuery } from "@tanstack/react-query";
import type { FeatureFlag } from "@sms/shared";
import { api } from "./api";

/** Public shop config (/api/config): company name for /terms /privacy, bot, feature flags (A6). */
export function useAppConfig() {
  return useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: 10 * 60_000 });
}
export function useFeature(flag: FeatureFlag): boolean {
  return useAppConfig().data?.features.includes(flag) ?? false;
}

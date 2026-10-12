// D-137: the gazetteer lists for the cascading pickers (cached for the session — the official list does not change) and the
// empty address of the customer dialog
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type AddressValue = { house_no: string; street: string; borey_id: string; province_code: string; district_code: string; commune_code: string; village_code: string };
export const EMPTY_ADDRESS: AddressValue = { house_no: "", street: "", borey_id: "", province_code: "", district_code: "", commune_code: "", village_code: "" };

/** the units under a code ("" = provinces) */
export function useGeo(parent: string, enabled = true) {
  return useQuery({ queryKey: ["geo", parent], queryFn: () => api.geo(parent), enabled, staleTime: Infinity, gcTime: Infinity });
}

// D-137 / D-140: the gazetteer lists for the cascading pickers (cached for the session — the official list does not change) and
// the address of the customer dialog
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type AddressValue = {
  /** «ក្នុងបុរី» (zone inside): then a borey project and its zone («Zone B») */
  in_borey: boolean; borey_id: string; borey_zone: string;
  house_no: string; street: string; province_code: string; district_code: string; commune_code: string; village_code: string;
};
export const EMPTY_ADDRESS: AddressValue = { in_borey: false, borey_id: "", borey_zone: "", house_no: "", street: "", province_code: "", district_code: "", commune_code: "", village_code: "" };

/** the units under a code ("" = provinces) */
export function useGeo(parent: string, enabled = true) {
  return useQuery({ queryKey: ["geo", parent], queryFn: () => api.geo(parent), enabled, staleTime: Infinity, gcTime: Infinity });
}

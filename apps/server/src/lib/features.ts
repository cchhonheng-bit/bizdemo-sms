// Feature flags per shop (A6): FEATURES=subscribe,reminders,inventory,accounting … — a module that is off does not exist.
import { parseFeatures, type FeatureFlag } from "@sms/shared";
import { config } from "../config.js";

export const features = (): FeatureFlag[] => parseFeatures(config.shop.features);
export const featureOn = (flag: FeatureFlag): boolean => features().includes(flag);

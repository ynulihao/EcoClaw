import type { RoutingProfile, RoutingProfileName } from "./types.js";

export const ROUTING_PROFILES: Record<RoutingProfileName, RoutingProfile> = {
  best: {
    name: "best",
    qualityWeight: 0.99,
    costWeight: 0.01,
  },
  balanced: {
    name: "balanced",
    qualityWeight: 0.50,
    costWeight: 0.50,
  },
  eco: {
    name: "eco",
    qualityWeight: 0.20,
    costWeight: 0.80,
  },
};

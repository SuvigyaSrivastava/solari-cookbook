import { createLocalSolariClient } from "./local.js";
import { createLiveSolariClient } from "./live.js";
import type { SolariClient } from "./types.js";

export type { SolariClient, SolariSession } from "./types.js";

/** $/hour, per the brief's Starter-plan pricing table (§1). */
export const SOLARI_BROWSER_USD_PER_HOUR = 0.1;
export const SOLARI_CAPTCHA_USD_PER_SOLVE = 0.01;

export function createSolariClient(apiKey?: string | null): SolariClient {
  const key = apiKey ?? process.env.SOLARI_API_KEY ?? "";
  return key ? createLiveSolariClient(key) : createLocalSolariClient();
}

export function browserHoursToUsd(hours: number): number {
  return hours * SOLARI_BROWSER_USD_PER_HOUR;
}

export function durationMsToBrowserHours(durationMs: number): number {
  return durationMs / (1000 * 60 * 60);
}

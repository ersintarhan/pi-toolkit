/**
 * CrofAI provider — OpenAI-compatible endpoint with a stale-while-revalidate
 * model list.
 *
 * Extracted from the monolithic index.ts so the entry point stays a thin
 * wiring layer. Exposes `registerCrofaiProvider(pi)` which registers the
 * static fallback catalog immediately and refreshes it from the live
 * /models endpoint on session_start.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../logger.js";

const log = createLogger("crofai");

const CROFAI_BASE_URL = "https://crof.ai/v1";
const CROFAI_MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let crofaiModelsCache: unknown[] | null = null;
let crofaiModelsLastFetch = 0;
let crofaiModelsRefreshInFlight: Promise<unknown[]> | null = null;
// Signature of the last-registered model list; skip re-registration when it
// hasn't changed to avoid clobbering active-model/selection state on every
// session_start when the SWR cache still holds.
let crofaiModelsSignature: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isNaN(n) ? 0 : n;
}

function mapCrofaiModel(m: Record<string, unknown>): ProviderModelConfig {
  const pricing = (isRecord(m.pricing) ? m.pricing : {}) as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : "unknown";
  return {
    id,
    name: typeof m.name === "string" ? m.name : id,
    reasoning: m.custom_reasoning === true || m.reasoning_effort === true,
    input: ["text"],
    cost: {
      input: toNum(pricing.prompt),
      output: toNum(pricing.completion),
      cacheRead: toNum(pricing.cache_prompt),
      cacheWrite: 0,
    },
    contextWindow: typeof m.context_length === "number" ? m.context_length : 128_000,
    maxTokens: typeof m.max_completion_tokens === "number" ? m.max_completion_tokens : 16_384,
  };
}

async function refreshCrofaiModels(apiKey: string): Promise<unknown[]> {
  const res = await fetch(`${CROFAI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`CrofAI models HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  const models = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  crofaiModelsCache = models;
  crofaiModelsLastFetch = Date.now();
  return models;
}

const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "openai/gpt-4o",
    name: "openai/gpt-4o",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
];

/** Register the static fallback catalog immediately. */
export function registerCrofaiProvider(pi: ExtensionAPI): void {
  pi.registerProvider("crofai", {
    baseUrl: CROFAI_BASE_URL,
    apiKey: "$CROFAI_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: (crofaiModelsCache as Record<string, unknown>[] | null)?.map(mapCrofaiModel) ?? FALLBACK_MODELS,
  });
}
export async function refreshCrofaiModelsIfNeeded(
  pi: ExtensionAPI,
  apiKey: string,
): Promise<void> {
  if (crofaiModelsCache && Date.now() - crofaiModelsLastFetch < CROFAI_MODELS_CACHE_TTL_MS) {
    return;
  }
  try {
    crofaiModelsRefreshInFlight ??= refreshCrofaiModels(apiKey).finally(() => {
      crofaiModelsRefreshInFlight = null;
    });
    const raw = (await crofaiModelsRefreshInFlight) as Record<string, unknown>[];
    const models = raw.map(mapCrofaiModel);
    const signature = JSON.stringify(models);
    if (signature === crofaiModelsSignature) return;
    crofaiModelsSignature = signature;
    pi.registerProvider("crofai", {
      baseUrl: CROFAI_BASE_URL,
      apiKey: "$CROFAI_API_KEY",
      api: "openai-completions",
      authHeader: true,
      models,
    });
  } catch (err) {
    log.error("model refresh failed:", err);
    // Stale or fallback models are fine.
  }
}

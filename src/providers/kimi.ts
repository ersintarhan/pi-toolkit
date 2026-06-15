/**
 * Kimi Code provider — OAuth device-code flow, dual-protocol streaming
 * (Anthropic-Messages or OpenAI-Completions), file upload, prompt-cache key
 * injection, and "(Empty response: ...)" suppression.
 *
 * Extracted from the monolithic index.ts. Everything Kimi-specific lives here;
 * index.ts only wires it into the extension entry point.
 *
 * API endpoint: https://api.kimi.com/coding (Anthropic Messages compatible)
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  AssistantMessageEvent,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  Api,
  createAssistantMessageEventStream,
  streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, OAuthCredential } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { streamSimpleAnthropicCached } from "../cached-anthropic-stream.js";
import { createLogger } from "../logger.js";

const log = createLogger("kimi-coding");

// =============================================================================
// Constants
// =============================================================================

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const PROTOCOL =
  process.env.KIMI_CODE_PROTOCOL === "openai" ? "openai-completions" : "anthropic-messages";
const DEFAULT_BASE_URL =
  PROTOCOL === "openai-completions"
    ? "https://api.kimi.com/coding/v1"
    : "https://api.kimi.com/coding";
const KIMI_CLI_VERSION = "1.30.0";
const KIMI_CLI_USER_AGENT = `KimiCLI/${KIMI_CLI_VERSION}`;
const KIMI_PLATFORM = "kimi_cli";
const DEVICE_ID_PATH = join(os.homedir(), ".pi", "providers", "kimi-coding", "device_id");
const PROVIDER_ID = "kimi-coding";
const EMPTY_RESPONSE_PREFIX = "(Empty response:";
const DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES = 1 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type Uploader = (mimeType: string, data: string) => Promise<string | null>;

interface KimiEnvOverrides {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

interface KimiPayloadContext {
  api: "anthropic-messages" | "openai-completions";
  upload?: Uploader;
  cacheKey?: string;
  cacheRetention: CacheRetention;
  reasoning?: ThinkingLevel;
  envOverrides: KimiEnvOverrides;
}

// =============================================================================
// Device identification + headers
// =============================================================================

export function getOAuthHost(): string {
  const value =
    process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST;
  return value.trim() || DEFAULT_OAUTH_HOST;
}

export function getBaseUrl(): string {
  const value = process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL;
  return value.trim() || DEFAULT_BASE_URL;
}

function createDeviceId(): string {
  return randomBytes(16).toString("hex");
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support it.
  }
}

function readPersistedDeviceId(): string | null {
  try {
    if (!existsSync(DEVICE_ID_PATH)) return null;
    const deviceId = readFileSync(DEVICE_ID_PATH, "utf8").trim();
    return deviceId || null;
  } catch {
    return null;
  }
}

function persistDeviceId(deviceId: string): void {
  try {
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, deviceId, "utf8");
    ensurePrivateFile(DEVICE_ID_PATH);
  } catch {
    // Ignore persistence failures and fall back to the in-memory device id.
  }
}

function getMacOSVersion(): string {
  try {
    return execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
  } catch {
    return os.release();
  }
}

function getDeviceModel(): string {
  const platform = process.platform;
  const arch = os.machine() || process.arch;
  if (platform === "darwin") {
    const version = getMacOSVersion();
    return version && arch ? `macOS ${version} ${arch}` : `macOS ${arch}`;
  }
  if (platform === "win32") {
    const release = os.release();
    return release && arch ? `Windows ${release} ${arch}` : `Windows ${arch}`;
  }
  const release = os.release();
  return release && arch ? `${platform} ${release} ${arch}` : `${platform} ${arch}`;
}

function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const trimmed = value.trim();
  /* oxlint-disable-next-line no-control-regex */
  if (/^[\x00-\x7F]*$/.test(trimmed)) {
    return trimmed;
  }
  /* oxlint-disable-next-line no-control-regex */
  const sanitized = trimmed.replace(/[^\x00-\x7F]/g, "").trim();
  return sanitized || fallback;
}

const DEVICE_MODEL = getDeviceModel();
let DEVICE_ID: string | null = null;

function getStableDeviceId(): string {
  if (DEVICE_ID) {
    return DEVICE_ID;
  }

  const persisted = readPersistedDeviceId();
  if (persisted) {
    DEVICE_ID = persisted;
    return DEVICE_ID;
  }

  DEVICE_ID = createDeviceId();
  persistDeviceId(DEVICE_ID);
  return DEVICE_ID;
}

export function getCommonHeaders(): Record<string, string> {
  const headers = {
    "User-Agent": KIMI_CLI_USER_AGENT,
    "X-Msh-Platform": KIMI_PLATFORM,
    "X-Msh-Version": KIMI_CLI_VERSION,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": DEVICE_MODEL,
    "X-Msh-Os-Version": os.release(),
    "X-Msh-Device-Id": getStableDeviceId(),
  };
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, asciiHeaderValue(value)]),
  ) as Record<string, string>;
}

// =============================================================================
// OAuth device flow
// =============================================================================

interface DeviceAuthorization {
  user_code: string;
  device_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function requestDeviceAuthorization(): Promise<DeviceAuthorization> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Device authorization failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    user_code?: string;
    device_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.user_code || !data.device_code || !data.verification_uri_complete) {
    throw new Error("Invalid device authorization response");
  }

  return {
    user_code: data.user_code,
    device_code: data.device_code,
    verification_uri: data.verification_uri || "",
    verification_uri_complete: data.verification_uri_complete,
    expires_in: data.expires_in || 1800,
    interval: data.interval || 5,
  };
}

async function requestDeviceToken(auth: DeviceAuthorization): Promise<TokenResponse | null> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: auth.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (response.status === 200) {
    const data = (await response.json()) as TokenResponse;
    if (data.access_token && data.refresh_token) {
      return data;
    }
    throw new Error("Token response missing required fields");
  }

  if (response.status === 400) {
    const data = (await response.json()) as { error?: string; error_description?: string };
    if (data.error === "authorization_pending") {
      return null;
    }
    if (data.error === "expired_token") {
      throw new Error("expired_token");
    }
    throw new Error(`Token request failed: ${data.error_description || data.error || "unknown"}`);
  }

  const text = await response.text().catch(() => "");
  throw new Error(`Token request failed: ${response.status} ${text}`);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${getOAuthHost()}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...getCommonHeaders(),
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Token refresh unauthorized: ${text}`);
    }
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token refresh response missing required fields");
  }

  return data;
}

async function loginKimiCode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  // Keep trying until we get a token (handles expired device codes)
  while (true) {
    const auth = await requestDeviceAuthorization();

    callbacks.onAuth({
      url: auth.verification_uri_complete,
      instructions: `Please visit the URL to authorize. Your code: ${auth.user_code}`,
    });

    const interval = Math.max(auth.interval, 1) * 1000;
    const expiresAt = Date.now() + auth.expires_in * 1000;

    let token: TokenResponse | null = null;
    let printedWaiting = false;

    while (Date.now() < expiresAt) {
      try {
        token = await requestDeviceToken(auth);
        if (token) break;
      } catch (error) {
        if (error instanceof Error && error.message === "expired_token") {
          // Device code expired, restart the flow
          if (callbacks.onProgress) {
            callbacks.onProgress("Device code expired, restarting...");
          }
          break;
        }
        throw error;
      }

      if (!printedWaiting) {
        if (callbacks.onProgress) {
          callbacks.onProgress("Waiting for authorization...");
        }
        printedWaiting = true;
      }

      // Check for abort
      if (callbacks.signal?.aborted) {
        throw new Error("Authorization aborted");
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    if (token) {
      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
      };
    }

    // If we get here without a token, the device code expired - loop will retry
  }
}

async function refreshKimiCodeToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const token = await refreshAccessToken(credentials.refresh);
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000,
  };
}

// =============================================================================
// Payload helpers (pure utilities)
// =============================================================================

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveCacheRetention(value?: CacheRetention): CacheRetention {
  if (value === "none" || value === "short" || value === "long") return value;
  if (process.env.PI_CACHE_RETENTION === "long") return "long";
  return "short";
}

function mapThinkingLevel(level?: string): { effort: string | null; enabled: boolean } | undefined {
  if (!level) return undefined;
  // "none"/"off" are defensive — ThinkingLevel type doesn't include them today,
  // but env overrides or future pi versions could pass them, so disable thinking.
  if (level === "none" || level === "off") return { effort: null, enabled: false };
  if (level === "minimal" || level === "low") return { effort: "low", enabled: true };
  if (level === "medium") return { effort: "medium", enabled: true };
  if (level === "high" || level === "xhigh") return { effort: "high", enabled: true };
  return undefined;
}

function parseInlineUploadThreshold(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_KIMI_INLINE_UPLOAD_THRESHOLD_BYTES;
}

function deriveFilesBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+)(?:;[^,]*)*;base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
}

function getUploadFilename(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "upload.jpg",
    "image/png": "upload.png",
    "image/gif": "upload.gif",
    "image/webp": "upload.webp",
    "video/mp4": "upload.mp4",
    "video/quicktime": "upload.mov",
  };
  return map[mimeType] ?? (mimeType.startsWith("video/") ? "upload.mp4" : "upload.bin");
}

function readFiniteEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  if (Number.isFinite(value)) return value;
  log.warn(`ignoring invalid numeric env ${name}=${JSON.stringify(raw)}`);
  return undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (Number.isFinite(value) && value > 0) return value;
  log.warn(`ignoring invalid integer env ${name}=${JSON.stringify(raw)}`);
  return undefined;
}

function readEnvOverrides(): KimiEnvOverrides {
  const out: KimiEnvOverrides = {};
  const temp = readFiniteEnvNumber("KIMI_MODEL_TEMPERATURE");
  if (temp !== undefined) out.temperature = temp;
  const topP = readFiniteEnvNumber("KIMI_MODEL_TOP_P");
  if (topP !== undefined) out.topP = topP;
  const maxTokens = readPositiveIntEnv("KIMI_MODEL_MAX_TOKENS");
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  return out;
}

// =============================================================================
// File upload (I/O edge)
// =============================================================================

async function uploadKimiFile(
  apiKey: string,
  mimeType: string,
  data: string,
): Promise<string | null> {
  const buffer = Buffer.from(data, "base64");
  const isVideo = mimeType.startsWith("video/");
  const threshold = parseInlineUploadThreshold(process.env.KIMI_CODE_UPLOAD_THRESHOLD_BYTES);
  if (!isVideo && buffer.length <= threshold) return null;

  const filename = getUploadFilename(mimeType);
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("purpose", isVideo ? "video" : "image");

  const baseUrl = getBaseUrl();
  const uploadUrl = `${deriveFilesBaseUrl(baseUrl)}/files`;
  log.debug(`Uploading ${filename} to ${uploadUrl} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);

  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, ...getCommonHeaders() },
      body: formData,
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const fileObj = (await response.json()) as { id?: string };
    if (!fileObj.id) throw new Error("missing file id");
    const fileUrl = `ms://${fileObj.id}`;
    log.debug(`Upload success: ${fileUrl}`);
    return fileUrl;
  } catch (err) {
    log.error("Upload failed:", err);
    return null;
  }
}

// =============================================================================
// Payload file transformers (pure given an Uploader)
// =============================================================================

async function transformOpenAIPayloadFiles(payload: JsonRecord, upload: Uploader): Promise<void> {
  if (!Array.isArray(payload.messages)) return;
  const cache = new Map<string, string>();

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const key =
        block.type === "image_url" ? "image_url" : block.type === "video_url" ? "video_url" : null;
      if (!key) continue;

      const field = block[key];
      const urlValue =
        typeof field === "string"
          ? field
          : isRecord(field) && typeof field.url === "string"
            ? field.url
            : null;
      if (!urlValue || urlValue.startsWith("ms://")) continue;

      const parsed = parseDataUrl(urlValue);
      if (!parsed) continue;

      const uploaded = cache.get(urlValue) ?? (await upload(parsed.mimeType, parsed.data));
      if (!uploaded) continue;
      cache.set(urlValue, uploaded);

      block[key] =
        typeof field === "string" ? uploaded : { ...(field as JsonRecord), url: uploaded };
    }
  }
}

async function transformAnthropicPayloadFiles(
  payload: JsonRecord,
  upload: Uploader,
): Promise<void> {
  if (!Array.isArray(payload.messages)) return;
  const cache = new Map<string, string>();

  const transformImageBlock = async (block: unknown): Promise<unknown> => {
    if (!isRecord(block) || block.type !== "image") return block;
    const source = block.source;
    if (!isRecord(source) || source.type !== "base64") return block;
    const mediaType = source.media_type;
    const data = source.data;
    if (typeof mediaType !== "string" || typeof data !== "string") return block;

    const cacheKey = `${mediaType}:${data}`;
    const uploaded = cache.get(cacheKey) ?? (await upload(mediaType, data));
    if (!uploaded) return block;
    cache.set(cacheKey, uploaded);

    const next: JsonRecord = { type: "image", source: { type: "url", url: uploaded } };
    if (block.cache_control !== undefined) next.cache_control = block.cache_control;
    return next;
  };

  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i];
      if (isRecord(block) && block.type === "tool_result" && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          block.content[j] = await transformImageBlock(block.content[j]);
        }
        continue;
      }
      message.content[i] = await transformImageBlock(block);
    }
  }
}

// =============================================================================
// Payload mutation pipeline
// =============================================================================

async function applyKimiPayloadMutations(
  payload: JsonRecord,
  ctx: KimiPayloadContext,
): Promise<void> {
  // 1. Map unsupported roles: Kimi does not recognize "developer" (OpenAI-specific).
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((msg) =>
      isRecord(msg) && msg.role === "developer" ? { ...msg, role: "system" } : msg,
    );
  }

  // 2. File upload dispatch (protocol-specific).
  if (ctx.upload) {
    if (ctx.api === "openai-completions") {
      await transformOpenAIPayloadFiles(payload, ctx.upload);
    } else if (ctx.api === "anthropic-messages") {
      await transformAnthropicPayloadFiles(payload, ctx.upload);
    }
  }

  // 3. prompt_cache_key injection.
  if (ctx.cacheRetention !== "none") {
    const existing = payload.prompt_cache_key;
    const resolved = (typeof existing === "string" && existing) || ctx.cacheKey;
    if (resolved) payload.prompt_cache_key = resolved;
  }

  // 4. Env-level hyperparameter overrides.
  const { temperature, topP, maxTokens } = ctx.envOverrides;
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;

  // 5. Reasoning effort mapping.
  if (ctx.reasoning) {
    const mapped = mapThinkingLevel(ctx.reasoning);
    if (mapped) {
      payload.reasoning_effort = mapped.effort;
      const extraBody = isRecord(payload.extra_body) ? payload.extra_body : {};
      extraBody.thinking = { type: mapped.enabled ? "enabled" : "disabled" };
      payload.extra_body = extraBody;
    }
  }
}

// =============================================================================
// Event stream filter: suppress Kimi "(Empty response: ...)" text blocks
// =============================================================================

// Buffer each text block until text_end so we can detect the full
// "(Empty response: ...)" prefix, then flush as a burst. This delays the
// first-token latency for a block until the block finishes; acceptable for
// Kimi since text blocks are typically short, and necessary to suppress the
// spurious empty-response artifacts Kimi emits.
async function* filterEmptyResponseStream(
  upstream: AsyncIterable<AssistantMessageEvent>,
): AsyncIterable<AssistantMessageEvent> {
  const suppressedIndices = new Set<number>();
  let textBuffer: AssistantMessageEvent[] = [];
  let bufferingIndex: number | null = null;

  for await (const event of upstream) {
    if (event.type === "text_start") {
      bufferingIndex = event.contentIndex;
      textBuffer = [event];
      continue;
    }

    if (
      bufferingIndex !== null &&
      "contentIndex" in event &&
      event.contentIndex === bufferingIndex
    ) {
      if (event.type === "text_delta") {
        textBuffer.push(event);
        continue;
      }
      if (event.type === "text_end") {
        if (event.content.startsWith(EMPTY_RESPONSE_PREFIX)) {
          suppressedIndices.add(bufferingIndex);
        } else {
          for (const buffered of textBuffer) yield buffered;
          yield event;
        }
        textBuffer = [];
        bufferingIndex = null;
        continue;
      }
    }

    if ("contentIndex" in event && suppressedIndices.has(event.contentIndex)) {
      continue;
    }

    if (event.type === "done" && suppressedIndices.size > 0) {
      event.message.content = event.message.content.filter(
        (block) =>
          !(
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith(EMPTY_RESPONSE_PREFIX)
          ),
      );
    }

    yield event;
  }
}

// =============================================================================
// Auth refresh: recover from server-side token invalidation
// =============================================================================

async function refreshKimiAuthToken(
  currentKey: string,
  opts: { forceNetworkRefresh?: boolean } = {},
): Promise<string | null> {
  try {
    const storage = AuthStorage.create();
    const cred = storage.get(PROVIDER_ID);
    if (!cred || cred.type !== "oauth") {
      log.warn(`auth refresh skipped: no OAuth credentials for ${PROVIDER_ID} on disk`);
      return null;
    }

    if (!opts.forceNetworkRefresh && cred.access !== currentKey && Date.now() < cred.expires) {
      log.info("auth refresh: trying newer on-disk token");
      return cred.access;
    }

    log.info(
      opts.forceNetworkRefresh
        ? "auth refresh: forcing network refresh"
        : "auth refresh: requesting new access token",
    );
    const refreshed = await refreshAccessToken(cred.refresh);
    const newCred: OAuthCredential = {
      type: "oauth",
      access: refreshed.access_token,
      refresh: refreshed.refresh_token,
      expires: Date.now() + refreshed.expires_in * 1000,
    };
    storage.set(PROVIDER_ID, newCred);
    log.info("auth refresh: new token persisted");
    return newCred.access;
  } catch (err) {
    log.error("auth refresh failed:", err);
    return null;
  }
}

// =============================================================================
// Stream wrapper
// =============================================================================

function makeErrorEvent(
  api: "anthropic-messages" | "openai-completions" = "anthropic-messages",
  message?: string,
): AssistantMessageEvent & { type: "error" } {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api,
      provider: PROVIDER_ID,
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      timestamp: Date.now(),
      errorMessage: message ?? "Kimi stream failed",
    },
  };
}

export function streamSimpleKimi(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const api = (model.api === "openai-completions" ? "openai-completions" : "anthropic-messages") as "anthropic-messages" | "openai-completions";
  const filtered = createAssistantMessageEventStream();
  const initialKey = options?.apiKey || process.env.KIMI_API_KEY || "";

  const cacheKeyOverride = (
    options as (SimpleStreamOptions & { prompt_cache_key?: unknown }) | undefined
  )?.prompt_cache_key;
  const cacheKey = (typeof cacheKeyOverride === "string" && cacheKeyOverride) || options?.sessionId;
  const cacheRetention = resolveCacheRetention(options?.cacheRetention);
  const envOverrides = readEnvOverrides();
  const originalOnPayload = options?.onPayload;

  const buildPatchedOptions = (apiKey: string): SimpleStreamOptions => {
    const upload: Uploader | undefined = apiKey
      ? (mimeType, data) => uploadKimiFile(apiKey, mimeType, data)
      : undefined;
    return {
      ...options,
      apiKey,
      onPayload: async (payload, modelData) => {
        let nextPayload: unknown = payload;

        if (isRecord(nextPayload)) {
          await applyKimiPayloadMutations(nextPayload, {
            api,
            upload,
            cacheKey,
            cacheRetention,
            reasoning: options?.reasoning,
            envOverrides,
          });
        }

        if (originalOnPayload) {
          const res = await originalOnPayload(nextPayload, modelData);
          if (res !== undefined) nextPayload = res;
        }

        return nextPayload;
      },
    };
  };

  void (async () => {
    try {
      let attempt = 0;
      let currentKey = initialKey;

      while (true) {
        const patchedOptions = buildPatchedOptions(currentKey);
        const upstream =
          api === "openai-completions"
            ? streamSimpleOpenAICompletions(
                model as Model<"openai-completions">,
                context,
                patchedOptions,
              )
            : streamSimpleAnthropicCached(
                model as Model<"anthropic-messages">,
                context,
                patchedOptions,
              );

        let pushedAny = false;
        let shouldRetry = false;

        try {
          for await (const event of filterEmptyResponseStream(upstream)) {
            if (!pushedAny && attempt < 2 && event.type === "error") {
              log.warn(
                `upstream error on first event, attempting refresh: ${event.error?.errorMessage?.slice(0, 200)}`,
              );
              const refreshed = await refreshKimiAuthToken(currentKey, {
                forceNetworkRefresh: attempt > 0,
              });
              if (refreshed && refreshed !== currentKey) {
                log.info("retrying stream with refreshed token");
                currentKey = refreshed;
                shouldRetry = true;
                break;
              }
              log.warn("refresh did not yield a new token, forwarding original error");
            }
            filtered.push(event);
            pushedAny = true;
          }
        } catch (err) {
          log.error("stream error:", err);

          if (!pushedAny && attempt < 2) {
            const refreshed = await refreshKimiAuthToken(currentKey, {
              forceNetworkRefresh: attempt > 0,
            });
            if (refreshed && refreshed !== currentKey) {
              log.info("retrying thrown stream error with refreshed token");
              currentKey = refreshed;
              shouldRetry = true;
            }
          }

          if (!shouldRetry) {
            filtered.push(makeErrorEvent(api, err instanceof Error ? err.message : String(err)));
          }
        }

        if (shouldRetry) {
          attempt++;
          continue;
        }
        break;
      }
    } catch (err) {
      log.error("stream bootstrap failed:", err);
      filtered.push(makeErrorEvent(api, err instanceof Error ? err.message : String(err)));
    }
  })();

  return filtered;
}

// =============================================================================
// Provider registration
// =============================================================================

export function registerKimiProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: getBaseUrl(),
    apiKey: "$KIMI_API_KEY",
    api: PROTOCOL,
    streamSimple: streamSimpleKimi,
    headers: getCommonHeaders(),
    models: [
      {
        id: "kimi-for-coding",
        name: "Kimi for Coding",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32000,
      },
    ],
    oauth: {
      name: "Kimi Code (OAuth)",
      login: loginKimiCode,
      refreshToken: refreshKimiCodeToken,
      getApiKey: (cred) => cred.access,
    },
  });
}

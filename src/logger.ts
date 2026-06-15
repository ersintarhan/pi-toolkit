/**
 * Namespace'd file logger for pi extensions.
 *
 * Why this exists: pi surfaces extension `console.*` output to the
 * transcript / input-editor area, which is terrible UX (clutters the UI,
 * conflicts with powerline-footer) and was the root cause of several status
 * "leaks". Every diagnostic that should never reach the user's eyes goes
 * through here instead.
 *
 * Logs append to `<piDir>/logs/<namespace>.log` (one file per namespace),
 * newline-delimited. The piDir honors PI_HOME and falls back to ~/.pi/agent.
 * Writes are best-effort: failures are swallowed so logging can never break
 * a session. A PI_DEBUG=1 env var additionally mirrors lines to stderr for
 * live `tail` during development.
 *
 * Usage:
 *   const log = createLogger("kimi-coding");
 *   log("upload failed", { url, error: String(err) });
 *   log.error("stream bootstrap failed:", err);   // level-tagged
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function getPiDir(): string {
  return process.env.PI_HOME ?? join(homedir(), ".pi", "agent");
}

function sanitize(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  /** Log an event with optional structured details. */
  (event: string, details?: Record<string, unknown>): void;
  /** Free-form level-tagged message (mirrors console.error ergonomics). */
  error(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
}

export function createLogger(namespace: string): Logger {
  const logPath = join(getPiDir(), "logs", `${namespace}.log`);
  const mirrorToStderr = process.env.PI_DEBUG === "1" || process.env.PI_TOOLKIT_DEBUG === "1";

  // Ensure the directory exists once at logger creation, not on every write.
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Directory creation is best-effort; write() will swallow its own errors.
  }

  const write = (line: string): void => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      // Logging is best-effort; never surface to the UI.
    }
    if (mirrorToStderr) {
      try {
        process.stderr.write(`[${namespace}] ${line}\n`);
      } catch {
        // ignore
      }
    }
  };

  const log = (event: string, details?: Record<string, unknown>): void => {
    // JSON.stringify can throw on circular references or BigInt values in
    // structured detail payloads. Wrap it so logging never breaks a session
    // (the contract documented in this module's header).
    let payload: string;
    try {
      payload = details && Object.keys(details).length > 0
        ? ` ${JSON.stringify({ event, ...details })}`
        : ` ${JSON.stringify({ event })}`;
    } catch {
      payload = ` ${JSON.stringify({ event, _details: "[unserializable]" })}`;
    }
    write(payload);
  };

  const tagged = (level: string, parts: unknown[]): void => {
    const text = parts.map(sanitize).join(" ").replace(ANSI_RE, "");
    write(`[${level.toUpperCase()}] ${text}`);
  };

  // Merge the call and property forms into a single callable logger.
  const logger = log as Logger;
  logger.error = (...parts: unknown[]) => tagged("error", parts);
  logger.warn = (...parts: unknown[]) => tagged("warn", parts);
  logger.info = (...parts: unknown[]) => tagged("info", parts);
  logger.debug = (...parts: unknown[]) => tagged("debug", parts);
  return logger;
}

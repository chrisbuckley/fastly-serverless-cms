import { Logger } from "fastly:logger";

import { getContext } from "./context.js";
import { truncateIp } from "./privacy.js";

const ENDPOINT = "edge-cms-app-logs";
const MAX_ERROR_BYTES = 200;

export type LogLevel = "info" | "warn" | "error";

let logger: Logger | null | undefined;

function emit(level: LogLevel, line: string): void {
  try {
    if (logger === undefined) logger = new Logger(ENDPOINT);
    logger?.log(line);
    return;
  } catch {
    logger = null;
  }
  if (level === "error") console.error(line);
  else console.log(line);
}

export function clip(text: string, max = MAX_ERROR_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.slice(0, max));
}

export function describeError(e: unknown): string {
  return clip(e instanceof Error ? e.message : String(e));
}

export function logLine(
  level: LogLevel,
  msg: string,
  fields: { status?: number; duration_ms?: number } = {},
): void {
  const ctx = getContext();
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    method: ctx.method,
    path: ctx.path,
    status: fields.status ?? 0,
    duration_ms: fields.duration_ms ?? 0,
    client_ip: ctx.trusted ? truncateIp(ctx.clientIp) : "",
  };
  emit(level, JSON.stringify(record));
}

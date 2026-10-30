import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FilterConfig {
  enabled: boolean;
  maxInputChars: number;
  maxOutputChars: number;
  timeoutMs: number;
}

export interface ContextConfig {
  recent: number;
  quotedBefore: number;
  quotedAfter: number;
  maxMessages: number;
  filter: FilterConfig;
}

export interface MediaConfig {
  enabled: boolean;
  dir: string;
  downloadImages: boolean;
  downloadFiles: boolean;
  maxFileBytes: number;
  ttlHours: number;
  maxTotalBytes: number;
  downloadTimeoutMs: number;
  attachImages: number;
}

export interface BridgeConfig {
  server: { host: string; port: number; path: string; accessToken: string };
  command: string;
  context: ContextConfig;
  media: MediaConfig;
  replyTimeoutMs: number;
  reactions: { resolving: string; done: string; fail: string };
  store: { path: string; keepPerGroup: number };
  groups: { allow: string[] };
}

export const DEFAULT_CONFIG: BridgeConfig = {
  server: { host: "127.0.0.1", port: 3001, path: "/onebot/v11/ws", accessToken: "" },
  command: "/pi",
  context: {
    recent: 20,
    quotedBefore: 10,
    quotedAfter: 5,
    maxMessages: 80,
    filter: { enabled: true, maxInputChars: 8000, maxOutputChars: 2000, timeoutMs: 30_000 },
  },
  media: {
    enabled: true,
    dir: "",
    downloadImages: true,
    downloadFiles: true,
    maxFileBytes: 20 * 1024 * 1024,
    ttlHours: 72,
    maxTotalBytes: 512 * 1024 * 1024,
    downloadTimeoutMs: 20_000,
    attachImages: 3,
  },
  replyTimeoutMs: 600_000,
  reactions: { resolving: "38", done: "148", fail: "10060" },
  store: { path: "", keepPerGroup: 500 },
  groups: { allow: [] },
};

export function configPath(agentDir: string): string {
  return join(agentDir, "llbot-bridge", "config.json");
}

export function loadConfig(agentDir: string, env: Record<string, string | undefined> = process.env): BridgeConfig {
  const path = configPath(agentDir);
  const fromFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeConfig>) : {};

  const merged: BridgeConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    server: { ...DEFAULT_CONFIG.server, ...(fromFile.server ?? {}) },
    context: {
      ...DEFAULT_CONFIG.context,
      ...(fromFile.context ?? {}),
      filter: { ...DEFAULT_CONFIG.context.filter, ...(fromFile.context?.filter ?? {}) },
    },
    media: { ...DEFAULT_CONFIG.media, ...(fromFile.media ?? {}) },
    reactions: { ...DEFAULT_CONFIG.reactions, ...(fromFile.reactions ?? {}) },
    store: { ...DEFAULT_CONFIG.store, ...(fromFile.store ?? {}) },
    groups: { ...DEFAULT_CONFIG.groups, ...(fromFile.groups ?? {}) },
  };

  if (env.PI_LLBOT_HOST) merged.server.host = env.PI_LLBOT_HOST;
  if (env.PI_LLBOT_PORT) merged.server.port = Number(env.PI_LLBOT_PORT);
  if (env.PI_LLBOT_PATH) merged.server.path = env.PI_LLBOT_PATH;
  if (env.PI_LLBOT_ACCESS_TOKEN) merged.server.accessToken = env.PI_LLBOT_ACCESS_TOKEN;
  if (env.PI_LLBOT_RECENT) merged.context.recent = Number(env.PI_LLBOT_RECENT);
  if (env.PI_LLBOT_QUOTED_BEFORE) merged.context.quotedBefore = Number(env.PI_LLBOT_QUOTED_BEFORE);
  if (env.PI_LLBOT_QUOTED_AFTER) merged.context.quotedAfter = Number(env.PI_LLBOT_QUOTED_AFTER);
  if (env.PI_LLBOT_FILTER) merged.context.filter.enabled = env.PI_LLBOT_FILTER !== "off";
  if (env.PI_LLBOT_MEDIA) merged.media.enabled = env.PI_LLBOT_MEDIA !== "off";
  if (env.PI_LLBOT_MEDIA_DIR) merged.media.dir = env.PI_LLBOT_MEDIA_DIR;
  if (env.PI_LLBOT_MEDIA_TTL_HOURS) merged.media.ttlHours = Number(env.PI_LLBOT_MEDIA_TTL_HOURS);
  if (env.PI_LLBOT_ATTACH_IMAGES) merged.media.attachImages = Number(env.PI_LLBOT_ATTACH_IMAGES);
  if (!merged.store.path) merged.store.path = join(agentDir, "llbot-bridge", "messages.db");
  if (!merged.media.dir) merged.media.dir = join(agentDir, "llbot-bridge", "cache");

  return merged;
}

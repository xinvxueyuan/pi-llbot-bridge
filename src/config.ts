import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FilterConfig {
  enabled: boolean;
  maxInputChars: number;
  maxOutputChars: number;
  timeoutMs: number;
  /** 模型输出少于原文这个比例时，判为「过度压缩」，退回完整上下文（0..1） */
  minKeepRatio: number;
}

export interface ContextConfig {
  recent: number;
  quotedBefore: number;
  quotedAfter: number;
  maxMessages: number;
  filter: FilterConfig;
}

export interface ForwardLongTextConfig {
  /** 超长答复改为「合并转发聊天记录」发送 */
  enabled: boolean;
  /** 超过多少字符触发 */
  thresholdChars: number;
  /** 每个节点的最大字符数 */
  nodeChars: number;
}

export interface RepliesConfig {
  /** 每轮最多发送几条消息：0=不发，-1=不设上限，其余夹在 0..10 */
  max: number;
  forwardLongText: ForwardLongTextConfig;
}

export interface MediaConfig {
  enabled: boolean;
  /** 允许 pi 主动上传图片/文件到群里 */
  allowUpload: boolean;
  /** 收到消息就预取附件（QQ 直链带 rkey 会过期，必须尽早下） */
  eagerDownload: boolean;
  dir: string;
  downloadImages: boolean;
  downloadFiles: boolean;
  maxFileBytes: number;
  ttlHours: number;
  maxTotalBytes: number;
  downloadTimeoutMs: number;
  attachImages: number;
}

export interface TriggerConfig {
  /** 是否允许「机器人自己账号」发出的消息触发（主人号自己给自己下命令） */
  allowSelf: boolean;
  /** 允许触发的主人 QQ 号；空数组 = 只要是 allowSelf 就放行 */
  owners: string[];
  /** 是否必须 @ 机器人才能触发；false（默认）= 消息以命令词开头即可 */
  requireMention: boolean;
}

export interface BridgeConfig {
  server: { host: string; port: number; path: string; accessToken: string };
  command: string;
  context: ContextConfig;
  media: MediaConfig;
  replies: RepliesConfig;
  autoStart: boolean;
  replyTimeoutMs: number;
  reactions: { resolving: string; done: string; fail: string; ping: string };
  store: { path: string; keepPerGroup: number };
  groups: { allow: string[] };
  trigger: TriggerConfig;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  server: { host: "127.0.0.1", port: 3001, path: "/onebot/v11/ws", accessToken: "" },
  command: "/pi",
  context: {
    recent: 20,
    quotedBefore: 10,
    quotedAfter: 5,
    maxMessages: 80,
    filter: { enabled: true, maxInputChars: 16_000, maxOutputChars: 6000, timeoutMs: 30_000, minKeepRatio: 0.6 },
  },
  media: {
    enabled: true,
    allowUpload: true,
    eagerDownload: true,
    dir: "",
    downloadImages: true,
    downloadFiles: true,
    maxFileBytes: 50 * 1024 * 1024,
    ttlHours: 72,
    maxTotalBytes: 512 * 1024 * 1024,
    downloadTimeoutMs: 20_000,
    attachImages: 3,
  },
  replies: {
    max: 3,
    forwardLongText: { enabled: true, thresholdChars: 600, nodeChars: 400 },
  },
  autoStart: true,
  replyTimeoutMs: 600_000,
  reactions: { resolving: "38", done: "148", fail: "10060", ping: "14" },
  store: { path: "", keepPerGroup: 500 },
  groups: { allow: [] },
  trigger: { allowSelf: false, owners: [], requireMention: false },
};

export function clampReplies(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.replies.max;
  if (value < 0) return -1;
  return Math.min(10, Math.floor(value));
}

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
    replies: {
      ...DEFAULT_CONFIG.replies,
      ...(fromFile.replies ?? {}),
      forwardLongText: { ...DEFAULT_CONFIG.replies.forwardLongText, ...(fromFile.replies?.forwardLongText ?? {}) },
    },
    reactions: { ...DEFAULT_CONFIG.reactions, ...(fromFile.reactions ?? {}) },
    store: { ...DEFAULT_CONFIG.store, ...(fromFile.store ?? {}) },
    groups: { ...DEFAULT_CONFIG.groups, ...(fromFile.groups ?? {}) },
    trigger: { ...DEFAULT_CONFIG.trigger, ...(fromFile.trigger ?? {}) },
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
  if (env.PI_LLBOT_ALLOW_SELF) merged.trigger.allowSelf = env.PI_LLBOT_ALLOW_SELF !== "off";
  if (env.PI_LLBOT_REACTION_PING) merged.reactions.ping = env.PI_LLBOT_REACTION_PING;
  if (env.PI_LLBOT_MAX_REPLIES) merged.replies.max = Number(env.PI_LLBOT_MAX_REPLIES);
  if (env.PI_LLBOT_AUTOSTART) merged.autoStart = env.PI_LLBOT_AUTOSTART !== "off";
  if (env.PI_LLBOT_REQUIRE_MENTION) merged.trigger.requireMention = env.PI_LLBOT_REQUIRE_MENTION !== "off";
  if (env.PI_LLBOT_OWNERS) {
    merged.trigger.owners = env.PI_LLBOT_OWNERS.split(",").map((v) => v.trim()).filter(Boolean);
  }
  merged.replies.max = clampReplies(merged.replies.max);
  if (!merged.store.path) merged.store.path = join(agentDir, "llbot-bridge", "messages.db");
  if (!merged.media.dir) merged.media.dir = join(agentDir, "llbot-bridge", "cache");

  return merged;
}

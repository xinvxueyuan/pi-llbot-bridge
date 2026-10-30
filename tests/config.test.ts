import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";

function agentDirWith(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-llbot-"));
  if (config !== undefined) {
    mkdirSync(join(dir, "llbot-bridge"), { recursive: true });
    writeFileSync(join(dir, "llbot-bridge", "config.json"), JSON.stringify(config), "utf8");
  }
  return dir;
}

describe("loadConfig", () => {
  it("无配置文件时用默认值（服务端/窗口/筛选/媒体齐全）", () => {
    const cfg = loadConfig(agentDirWith(), {});
    expect(cfg.server).toEqual({ host: "127.0.0.1", port: 3001, path: "/onebot/v11/ws", accessToken: "" });
    expect(cfg.command).toBe("/pi");
    expect(cfg.context).toEqual({
      recent: 20,
      quotedBefore: 10,
      quotedAfter: 5,
      maxMessages: 80,
      filter: { enabled: true, maxInputChars: 8000, maxOutputChars: 2000, timeoutMs: 30000 },
    });
    expect(cfg.media).toMatchObject({
      enabled: true,
      downloadImages: true,
      downloadFiles: true,
      maxFileBytes: 20971520,
      ttlHours: 72,
      maxTotalBytes: 536870912,
      attachImages: 3,
    });
    expect(cfg.reactions).toEqual({ resolving: "38", done: "148", fail: "10060", ping: "14" });
    expect(cfg.trigger).toEqual({ allowSelf: false, owners: [], requireMention: false });
    expect(cfg.replies).toEqual({ max: 3 });
    expect(cfg.autoStart).toBe(true);
    expect(cfg.media.allowUpload).toBe(true);
  });

  it("replies.max 夹在 -1..10，env 可覆盖", () => {
    expect(loadConfig(agentDirWith({ replies: { max: 12 } }), {}).replies.max).toBe(10);
    expect(loadConfig(agentDirWith({ replies: { max: -5 } }), {}).replies.max).toBe(-1);
    expect(loadConfig(agentDirWith(), { PI_LLBOT_MAX_REPLIES: "-1" }).replies.max).toBe(-1);
    expect(loadConfig(agentDirWith(), { PI_LLBOT_AUTOSTART: "off" }).autoStart).toBe(false);
  });

  it("env 覆盖主人号与自我触发开关", () => {
    const cfg = loadConfig(agentDirWith(), { PI_LLBOT_ALLOW_SELF: "on", PI_LLBOT_OWNERS: "1330509996, 42" });
    expect(cfg.trigger.allowSelf).toBe(true);
    expect(cfg.trigger.owners).toEqual(["1330509996", "42"]);
  });

  it("文件部分覆盖时保留其余默认（context/media/reactions 深合并）", () => {
    const cfg = loadConfig(
      agentDirWith({ context: { recent: 30, filter: { enabled: false } }, media: { ttlHours: 1 }, reactions: { fail: "9" } }),
      {},
    );
    expect(cfg.context.recent).toBe(30);
    expect(cfg.context.quotedBefore).toBe(10);
    expect(cfg.context.filter).toEqual({ enabled: false, maxInputChars: 8000, maxOutputChars: 2000, timeoutMs: 30000 });
    expect(cfg.media.ttlHours).toBe(1);
    expect(cfg.media.maxTotalBytes).toBe(536870912);
    expect(cfg.reactions).toEqual({ resolving: "38", done: "148", fail: "9", ping: "14" });
  });

  it("env 覆盖服务端参数", () => {
    const cfg = loadConfig(agentDirWith({ server: { port: 4000 } }), {
      PI_LLBOT_HOST: "0.0.0.0",
      PI_LLBOT_PORT: "4100",
      PI_LLBOT_PATH: "/custom",
      PI_LLBOT_ACCESS_TOKEN: "env-token",
    });
    expect(cfg.server).toEqual({ host: "0.0.0.0", port: 4100, path: "/custom", accessToken: "env-token" });
  });

  it("env 覆盖窗口与筛选参数", () => {
    const cfg = loadConfig(agentDirWith(), {
      PI_LLBOT_RECENT: "12",
      PI_LLBOT_QUOTED_BEFORE: "3",
      PI_LLBOT_QUOTED_AFTER: "4",
      PI_LLBOT_FILTER: "off",
    });
    expect(cfg.context.recent).toBe(12);
    expect(cfg.context.quotedBefore).toBe(3);
    expect(cfg.context.quotedAfter).toBe(4);
    expect(cfg.context.filter.enabled).toBe(false);
  });

  it("env 覆盖媒体参数（含关闭下载）", () => {
    const cfg = loadConfig(agentDirWith(), {
      PI_LLBOT_MEDIA: "off",
      PI_LLBOT_MEDIA_TTL_HOURS: "6",
      PI_LLBOT_ATTACH_IMAGES: "0",
    });
    expect(cfg.media.enabled).toBe(false);
    expect(cfg.media.ttlHours).toBe(6);
    expect(cfg.media.attachImages).toBe(0);
  });

  it("store.path 与 media.dir 缺省落在 <agentDir>/llbot-bridge/ 下", () => {
    const dir = agentDirWith();
    const cfg = loadConfig(dir, {});
    expect(cfg.store.path).toBe(join(dir, "llbot-bridge", "messages.db"));
    expect(cfg.store.keepPerGroup).toBe(500);
    expect(cfg.media.dir).toBe(join(dir, "llbot-bridge", "cache"));
    expect(DEFAULT_CONFIG.groups.allow).toEqual([]);
  });
});

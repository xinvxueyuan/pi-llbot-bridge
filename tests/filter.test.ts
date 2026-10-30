import { describe, expect, it, vi } from "vitest";
import { filterTranscript } from "../src/bridge/filter";
import type { StoredMessage } from "../src/types";

const m = (id: string, text: string, ts = 1_700_000_000): StoredMessage => ({
  groupId: "123",
  messageId: id,
  seq: Number(id),
  userId: "42",
  senderName: "张三",
  text,
  replyTo: null,
  ts,
  isSelf: false,
  attachments: [],
});

const config = { enabled: true, maxInputChars: 500, maxOutputChars: 200, timeoutMs: 50, minKeepRatio: 0 };

describe("filterTranscript（R11）", () => {
  it("上下文超过输出上限时才调模型，且用模型输出", async () => {
    const complete = vi.fn(async (_prompt: string) => `12:00 张三: 保留这条${"x".repeat(400)}`);
    const long = [m("1", "刷屏内容".repeat(60)), m("2", "保留这条")];
    const out = await filterTranscript(long, "解释上面", { config, complete });
    expect(out).toContain("保留这条");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0][0])).toContain("解释上面");
  });

  it("上下文不长（≤ maxOutputChars）时直接全量返回，不调模型", async () => {
    const complete = vi.fn(async (_prompt: string) => "不该被调用");
    const out = await filterTranscript([m("1", "第一句"), m("2", "第二句")], "问", { config, complete });
    expect(complete).toHaveBeenCalledTimes(0);
    expect(out).toContain("第一句");
    expect(out).toContain("第二句");
  });

  it("模型丢行过多（按行数比）时退回完整上下文，即使字符数够", async () => {
    const complete = vi.fn(async (_prompt: string) => `12:00 张三: ${"很长的保留行".repeat(80)}`);
    const messages = [m("1", "甲"), m("2", "乙"), m("3", "丙"), m("4", "丁"), m("5", "戊"), m("6", "己")];
    const out = await filterTranscript(messages, "问", { config: { ...config, minKeepRatio: 0.6 }, complete });
    expect(out).toContain("甲");
    expect(out).toContain("己");
  });

  it("模型抛错时退回确定性结果且不抛", async () => {
    const complete = vi.fn(async (_prompt: string) => {
      throw new Error("boom");
    });
    const out = await filterTranscript([m("1", "保留这条")], "问", { config, complete });
    expect(out).toContain("保留这条");
    expect(out).toContain("张三");
  });

  it("模型返回空串时退回确定性结果", async () => {
    const out = await filterTranscript([m("1", "保留这条")], "问", { config, complete: async () => "   " });
    expect(out).toContain("保留这条");
  });

  it("关闭筛选时一次模型都不调，且输出不超过 maxOutputChars", async () => {
    const complete = vi.fn(async (_prompt: string) => "不该被调用");
    const long = [m("1", "x".repeat(400)), m("2", "y".repeat(400))];
    const out = await filterTranscript(long, "问", { config: { ...config, enabled: false }, complete });
    expect(complete).toHaveBeenCalledTimes(0);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

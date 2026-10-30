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

const config = { enabled: true, maxInputChars: 500, maxOutputChars: 200, timeoutMs: 50 };

describe("filterTranscript（R11）", () => {
  it("启用且有模型时用模型输出", async () => {
    const complete = vi.fn(async (_prompt: string) => "12:00 张三: 保留这条");
    const out = await filterTranscript([m("1", "刷屏内容"), m("2", "保留这条")], "解释上面", { config, complete });
    expect(out).toBe("12:00 张三: 保留这条");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(String(complete.mock.calls[0][0])).toContain("解释上面");
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

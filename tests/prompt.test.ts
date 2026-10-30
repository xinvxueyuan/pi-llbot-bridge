import { describe, expect, it } from "vitest";
import { buildPrompt, type PromptAttachment } from "../src/bridge/prompt";
import type { StoredMessage } from "../src/types";

const quoted: StoredMessage = {
  groupId: "123",
  messageId: "9",
  seq: 109,
  userId: "7",
  senderName: "李四",
  text: "原始问题",
  replyTo: null,
  ts: 1_699_999_000,
  isSelf: false,
  attachments: [],
};

const attachment: PromptAttachment = { kind: "image", name: "cat.jpg", path: "C:/cache/ab/abc.jpg", from: "张三" };

const base = {
  turnId: "turn-1",
  selfName: "pi",
  groupId: "123",
  requester: "张三(42)",
  request: "你好pi-agent",
  transcript: "12:00 张三: 早",
  quoted: null,
  attachments: [] as PromptAttachment[],
  maxReplies: 3,
  mediaUpload: false,
};

describe("buildPrompt", () => {
  it("含 turn 标记、已筛选上下文与请求行", () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain("turn:turn-1");
    expect(prompt).toContain("12:00 张三: 早");
    expect(prompt).toContain("张三(42): 你好pi-agent");
  });

  it("有引用消息时插入引用块", () => {
    const prompt = buildPrompt({ ...base, quoted });
    expect(prompt).toContain("[被引用的消息] 李四(7)");
    expect(prompt).toContain("原始问题");
  });

  it("有本地附件时列出可直接读取的路径", () => {
    const prompt = buildPrompt({ ...base, attachments: [attachment] });
    expect(prompt).toContain("[本地附件]");
    expect(prompt).toContain("C:/cache/ab/abc.jpg");
    expect(prompt).toContain("张三");
  });

  it("结尾按上限说明发送条数", () => {
    expect(buildPrompt(base)).toContain("最多发送 3 条消息");
    expect(buildPrompt({ ...base, maxReplies: -1 })).toContain("不限条数");
    expect(buildPrompt({ ...base, maxReplies: 1 })).toContain("最多发送 1 条消息");
  });

  it("开启上传时提示 qq_send_media", () => {
    expect(buildPrompt({ ...base, mediaUpload: true })).toContain("qq_send_media");
    expect(buildPrompt(base)).not.toContain("qq_send_media");
  });
});

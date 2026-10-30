import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bridge, type BridgeDeps, type ContextInput } from "../src/bridge/bridge";
import { DEFAULT_CONFIG } from "../src/config";
import { MessageStore } from "../src/store/db";
import type { ObEvent } from "../src/types";

interface Call {
  action: string;
  params: Record<string, any>;
}

function makeBridge(overrides: Partial<BridgeDeps> = {}) {
  const calls: Call[] = [];
  const sent: Array<{ prompt: string; attachments: unknown[] }> = [];
  const store = new MessageStore(":memory:");
  const client = {
    call: async (action: string, params: Record<string, any> = {}) => {
      calls.push({ action, params });
      if (action === "get_msg") {
        return {
          message_id: params.message_id,
          message_seq: 700,
          time: 50,
          sender: { user_id: 7, nickname: "李四" },
          message: [{ type: "text", data: { text: "被引用的原文" } }],
        };
      }
      return {};
    },
  } as unknown as BridgeDeps["client"];
  const deps: BridgeDeps = {
    config: { ...DEFAULT_CONFIG, replyTimeoutMs: 60_000 },
    store,
    client,
    sendUserMessage: (prompt, attachments) => sent.push({ prompt, attachments }),
    isIdle: () => true,
    collectContext: async () => ({ transcript: "FIXED-TRANSCRIPT", attachments: [] }),
    ...overrides,
  };
  const bridge = new Bridge(deps);
  bridge.selfId = "999";
  bridge.selfName = "pi";
  return { bridge, calls, sent, store, deps };
}

function groupMessage(overrides: Partial<ObEvent> = {}): ObEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 999,
    group_id: 123,
    user_id: 42,
    message_id: 1001,
    message_seq: 5001,
    time: 100,
    sender: { user_id: 42, nickname: "张三" },
    message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " /pi 你好pi-agent" } }],
    ...overrides,
  };
}

describe("Bridge", () => {
  it("非群消息被忽略", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent({ post_type: "message", message_type: "private" });
    expect(calls).toHaveLength(0);
  });

  it("默认 requireMention=false：不 @ 也能触发", async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleEvent(groupMessage({ message: [{ type: "text", data: { text: "/pi hi" } }] }));
    expect(sent).toHaveLength(1);
  });

  it("requireMention=true 时没 @ 不触发", async () => {
    const { bridge, sent } = makeBridge({
      config: { ...DEFAULT_CONFIG, trigger: { ...DEFAULT_CONFIG.trigger, requireMention: true } },
    });
    await bridge.handleEvent(groupMessage({ message: [{ type: "text", data: { text: "/pi hi" } }] }));
    expect(sent).toHaveLength(0);
  });

  it("触发后先发 resolving 表态", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    expect(calls[0]).toEqual({ action: "set_msg_emoji_like", params: { message_id: 1001, emoji_id: "38", set: true } });
  });

  it("注入的提示含请求与筛选后的上下文，附件默认空", async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleEvent(groupMessage());
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("你好pi-agent");
    expect(sent[0].prompt).toContain("FIXED-TRANSCRIPT");
    expect(sent[0].attachments).toEqual([]);
  });

  it("会话忙时用 followUp 投递（否则 pi 会拒绝）", async () => {
    const options: Array<{ deliverAs?: string } | undefined> = [];
    const { bridge } = makeBridge({ isIdle: () => false, sendUserMessage: (_p, _a, o) => options.push(o) });
    await bridge.handleEvent(groupMessage());
    expect(options[0]).toEqual({ deliverAs: "followUp" });
  });

  it("collectContext 返回的附件原样传给 sendUserMessage 并写进提示", async () => {
    const attachment = { kind: "image", name: "cat.jpg", path: "C:/cache/ab/cat.jpg", from: "张三" };
    const { bridge, sent } = makeBridge({ collectContext: async () => ({ transcript: "T", attachments: [attachment] }) });
    await bridge.handleEvent(groupMessage());
    expect(sent[0].attachments).toEqual([attachment]);
    expect(sent[0].prompt).toContain("C:/cache/ab/cat.jpg");
  });

  it("collectContext 收到被引用的消息", async () => {
    const collectContext = vi.fn(async (_input: ContextInput) => ({ transcript: "T", attachments: [] }));
    const { bridge } = makeBridge({ collectContext });
    await bridge.handleEvent(
      groupMessage({
        message: [{ type: "reply", data: { id: 700 } }, { type: "at", data: { qq: "999" } }, { type: "text", data: { text: "/pi 看上面" } }],
      }),
    );
    expect(collectContext.mock.calls[0][0]).toMatchObject({ groupId: "123", request: "看上面" });
    expect((collectContext.mock.calls[0][0] as { quoted: { messageId: string } }).quoted.messageId).toBe("700");
  });

  it("collectContext 抛错时降级继续注入", async () => {
    const { bridge, sent } = makeBridge({
      collectContext: async () => {
        throw new Error("filter down");
      },
    });
    await bridge.handleEvent(groupMessage());
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("（无可用上下文）");
  });

  it("默认（allowSelf=false）自我消息不触发", async () => {
    const { bridge, sent } = makeBridge();
    await bridge.handleEvent(groupMessage({ post_type: "message_sent", user_id: 999 }));
    expect(sent).toHaveLength(0);
  });

  it("allowSelf + owners 命中时自我消息可触发", async () => {
    const { bridge, sent } = makeBridge({ config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["999"], requireMention: false } } });
    await bridge.handleEvent(groupMessage({ post_type: "message_sent", user_id: 999 }));
    expect(sent).toHaveLength(1);
  });

  it("allowSelf 但 owners 不匹配时不触发", async () => {
    const { bridge, sent } = makeBridge({ config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["123"], requireMention: false } } });
    await bridge.handleEvent(groupMessage({ post_type: "message_sent", user_id: 999 }));
    expect(sent).toHaveLength(0);
  });

  it("自己刚发出的回复（同 message_id）不会自激", async () => {
    const { bridge, sent } = makeBridge({
      config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["999"], requireMention: false } },
      client: { call: async (action: string) => (action === "send_group_msg" ? { message_id: 2001 } : {}) } as unknown as BridgeDeps["client"],
    });
    await bridge.handleEvent(groupMessage());
    await bridge.reply("答复");
    await bridge.handleEvent(
      groupMessage({ post_type: "message_sent", user_id: 999, message_id: 2001 }),
    );
    expect(sent).toHaveLength(1);
  });

  it("ping 在最近一条群消息上打 ping 表态", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    const result = await bridge.ping();
    expect(result).toEqual({ sent: true, groupId: "123" });
    const emoji = calls.filter((c) => c.action === "set_msg_emoji_like").pop()!;
    expect(emoji.params).toEqual({ message_id: 1001, emoji_id: "14", set: true });
  });

  it("没有处理过任何消息时 ping 不发", async () => {
    const { bridge, calls } = makeBridge();
    expect(await bridge.ping()).toEqual({ sent: false });
    expect(calls).toHaveLength(0);
  });

  it("忙碌时再触发只发提示，不新建 turn", async () => {
    const { bridge, calls, sent } = makeBridge();
    await bridge.handleEvent(groupMessage());
    await bridge.handleEvent(groupMessage({ message_id: 1002 }));
    expect(sent).toHaveLength(1);
    expect(calls.filter((c) => c.action === "send_group_msg").pop()?.params.message[0].data.text).toContain("上一条请求还在处理中");
  });

  it("reply 发送引用消息 + 文本，并累计次数", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    expect(await bridge.reply("答复正文")).toEqual({ sent: true, count: 1 });
    expect(calls.filter((c) => c.action === "send_group_msg").pop()!.params.message).toEqual([
      { type: "reply", data: { id: 1001 } },
      { type: "text", data: { text: "答复正文" } },
    ]);
  });

  it("达到发送上限后不再发送（max=1）", async () => {
    const { bridge, calls } = makeBridge({ config: { ...DEFAULT_CONFIG, replies: { max: 1, forwardLongText: { enabled: false, thresholdChars: 600, nodeChars: 400 } } } });
    await bridge.handleEvent(groupMessage());
    expect((await bridge.reply("第一条")).sent).toBe(true);
    const second = await bridge.reply("第二条");
    expect(second).toMatchObject({ sent: false, reason: "limit" });
    expect(calls.filter((c) => c.action === "send_group_msg")).toHaveLength(1);
  });

  it("max=-1 时可发多条", async () => {
    const { bridge, calls } = makeBridge({ config: { ...DEFAULT_CONFIG, replies: { max: -1, forwardLongText: { enabled: false, thresholdChars: 600, nodeChars: 400 } } } });
    await bridge.handleEvent(groupMessage());
    expect((await bridge.reply("一")).sent).toBe(true);
    expect((await bridge.reply("二")).sent).toBe(true);
    expect(calls.filter((c) => c.action === "send_group_msg")).toHaveLength(2);
  });

  it("图片以 base64 段发送并计入条数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-media-"));
    const file = join(dir, "a.png");
    writeFileSync(file, "png-bytes");
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    const result = await bridge.sendMedia({ path: file, kind: "image" });
    expect(result).toMatchObject({ sent: true, count: 1 });
    const sent = calls.filter((c) => c.action === "send_group_msg").pop()!;
    expect(sent.params.message[0].type).toBe("image");
    expect(String(sent.params.message[0].data.file)).toMatch(/^base64:\/\//);
  });

  it("文件走 upload_group_file 并带名字", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-media-"));
    const file = join(dir, "report.pdf");
    writeFileSync(file, "pdf-bytes");
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    expect(await bridge.sendMedia({ path: file, kind: "file" })).toMatchObject({ sent: true });
    const call = calls.filter((c) => c.action === "upload_group_file").pop()!;
    expect(call.params).toMatchObject({ group_id: 123, name: "report.pdf" });
  });

  it("不存在的文件不发", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    expect(await bridge.sendMedia({ path: "C:/nope/missing.png", kind: "image" })).toMatchObject({ sent: false, reason: "missing" });
    expect(calls.some((c) => c.action === "send_group_msg")).toBe(false);
  });

  it("媒体也受发送上限约束", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-media-"));
    const file = join(dir, "a.png");
    writeFileSync(file, "png-bytes");
    const { bridge } = makeBridge({ config: { ...DEFAULT_CONFIG, replies: { max: 1, forwardLongText: { enabled: false, thresholdChars: 600, nodeChars: 400 } } } });
    await bridge.handleEvent(groupMessage());
    expect((await bridge.reply("文字")).sent).toBe(true);
    expect(await bridge.sendMedia({ path: file, kind: "image" })).toMatchObject({ sent: false, reason: "limit" });
  });

  it("超长答复改为合并转发发送（按 nodeChars 切块）", async () => {
    const { bridge, calls } = makeBridge({
      config: {
        ...DEFAULT_CONFIG,
        replies: { max: -1, forwardLongText: { enabled: true, thresholdChars: 10, nodeChars: 5 } },
      },
    });
    await bridge.handleEvent(groupMessage());
    const text = "0123456789abcdefghij";
    const result = await bridge.reply(text);
    expect(result).toMatchObject({ sent: true, count: 1 });
    const call = calls.filter((c) => c.action === "send_forward_msg").pop();
    expect(call).toBeTruthy();
    const nodes = call!.params.messages as Array<{ type: string; data: { content: string; name: string; uin: number } }>;
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.every((node) => node.type === "node" && node.data.content.length <= 5)).toBe(true);
    expect(nodes.map((node) => node.data.content).join("")).toBe(text);
    expect(calls.some((c) => c.action === "send_group_msg")).toBe(false);
  });

  it("未超过阈值仍走普通消息", async () => {
    const { bridge, calls } = makeBridge({
      config: {
        ...DEFAULT_CONFIG,
        replies: { max: -1, forwardLongText: { enabled: true, thresholdChars: 100, nodeChars: 50 } },
      },
    });
    await bridge.handleEvent(groupMessage());
    await bridge.reply("短的");
    expect(calls.some((c) => c.action === "send_group_msg")).toBe(true);
    expect(calls.some((c) => c.action === "send_forward_msg")).toBe(false);
  });

  it("关闭 forwardLongText 后长文仍走普通消息", async () => {
    const { bridge, calls } = makeBridge({
      config: {
        ...DEFAULT_CONFIG,
        replies: { max: -1, forwardLongText: { enabled: false, thresholdChars: 10, nodeChars: 5 } },
      },
    });
    await bridge.handleEvent(groupMessage());
    await bridge.reply("0123456789abcdefghij");
    expect(calls.some((c) => c.action === "send_group_msg")).toBe(true);
    expect(calls.some((c) => c.action === "send_forward_msg")).toBe(false);
  });

  it("没调工具时用 lastText 兜底发送并打 done", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    bridge.markRunStarted("x turn:" + bridge.turn!.turnId);
    await bridge.settle({ aborted: false, lastText: "兜底答复" });
    expect(calls.some((c) => c.action === "send_group_msg" && c.params.message.some((seg: any) => seg.data?.text === "兜底答复"))).toBe(true);
    expect(calls.some((c) => c.action === "set_msg_emoji_like" && c.params.emoji_id === "148")).toBe(true);
    expect(bridge.turn).toBeNull();
  });

  it("aborted 打 fail 表态", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    await bridge.settle({ aborted: true });
    expect(calls.some((c) => c.action === "set_msg_emoji_like" && c.params.emoji_id === "10060")).toBe(true);
  });

  it("error 打 fail 表态并说明失败", async () => {
    const { bridge, calls } = makeBridge();
    await bridge.handleEvent(groupMessage());
    await bridge.settle({ aborted: false, error: "boom" });
    expect(calls.some((c) => c.action === "set_msg_emoji_like" && c.params.emoji_id === "10060")).toBe(true);
    expect(calls.some((c) => c.action === "send_group_msg" && String(c.params.message[0].data.text).includes("pi 执行失败"))).toBe(true);
  });

  it("超时打 fail 表态并清理", async () => {
    const { bridge, calls } = makeBridge({ config: { ...DEFAULT_CONFIG, replyTimeoutMs: 5 } });
    await bridge.handleEvent(groupMessage());
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.some((c) => c.action === "set_msg_emoji_like" && c.params.emoji_id === "10060")).toBe(true);
    expect(bridge.turn).toBeNull();
  });

  it("引用消息未入库时用 get_msg 拉取并写库", async () => {
    const { bridge, calls, store } = makeBridge();
    await bridge.handleEvent(
      groupMessage({
        message: [{ type: "reply", data: { id: 700 } }, { type: "at", data: { qq: "999" } }, { type: "text", data: { text: "/pi 看上面" } }],
      }),
    );
    expect(calls.some((c) => c.action === "get_msg" && c.params.message_id === 700)).toBe(true);
    expect(store.get("123", "700")?.text).toBe("被引用的原文");
  });
});

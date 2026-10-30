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

  it("没 @ 机器人不触发", async () => {
    const { bridge, sent } = makeBridge();
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
    const { bridge, sent } = makeBridge({ config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["999"] } } });
    await bridge.handleEvent(groupMessage({ post_type: "message_sent", user_id: 999 }));
    expect(sent).toHaveLength(1);
  });

  it("allowSelf 但 owners 不匹配时不触发", async () => {
    const { bridge, sent } = makeBridge({ config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["123"] } } });
    await bridge.handleEvent(groupMessage({ post_type: "message_sent", user_id: 999 }));
    expect(sent).toHaveLength(0);
  });

  it("自己刚发出的回复（同 message_id）不会自激", async () => {
    const { bridge, sent } = makeBridge({
      config: { ...DEFAULT_CONFIG, trigger: { allowSelf: true, owners: ["999"] } },
      client: { call: async (action: string) => (action === "send_group_msg" ? { message_id: 2001 } : {}) } as unknown as BridgeDeps["client"],
    });
    await bridge.handleEvent(groupMessage());
    await bridge.reply("答复");
    await bridge.handleEvent(
      groupMessage({ post_type: "message_sent", user_id: 999, message_id: 2001 }),
    );
    expect(sent).toHaveLength(1);
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

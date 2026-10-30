import { describe, expect, it } from "vitest";
import { extractCommand, fromApiMessage, mentions, replyTarget, segmentsOf, toStored } from "../src/llbot/parse";
import type { ObEvent } from "../src/types";

const at = (qq: string) => ({ type: "at", data: { qq } });
const text = (t: string) => ({ type: "text", data: { text: t } });

function groupEvent(overrides: Partial<ObEvent> = {}): ObEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 999,
    group_id: 123,
    user_id: 42,
    message_id: 1001,
    message_seq: 5001,
    time: 1_700_000_000,
    sender: { user_id: 42, nickname: "张三" },
    message: [at("999"), text(" /pi 你好pi-agent")],
    ...overrides,
  };
}

describe("parse", () => {
  it("replyTarget 取出 reply 段 id", () => {
    expect(replyTarget([{ type: "reply", data: { id: 777 } }, text("x")])).toBe("777");
    expect(replyTarget([text("x")])).toBeNull();
  });

  it("mentions 只认 selfId，不认 all", () => {
    expect(mentions([at("999")], "999")).toBe(true);
    expect(mentions([at("all")], "999")).toBe(false);
    expect(mentions([at("888")], "999")).toBe(false);
  });

  it("toStored 只接受群消息", () => {
    expect(toStored(groupEvent(), "999")).not.toBeNull();
    expect(toStored(groupEvent({ message_type: "private" }), "999")).toBeNull();
  });

  it("toStored 保留 message_seq 与 replyTo、isSelf，附件默认空数组", () => {
    const stored = toStored(groupEvent({ message: [{ type: "reply", data: { id: 700 } }, text("hi")] }), "999");
    expect(stored?.seq).toBe(5001);
    expect(stored?.replyTo).toBe("700");
    expect(stored?.isSelf).toBe(false);
    expect(stored?.attachments).toEqual([]);
    expect(toStored(groupEvent({ user_id: 999 }), "999")?.isSelf).toBe(true);
  });

  it("toStored 接受 message_sent（自我消息）并标记 isSelf", () => {
    const stored = toStored(groupEvent({ post_type: "message_sent", user_id: 999 }), "999");
    expect(stored?.isSelf).toBe(true);
    expect(stored?.messageId).toBe("1001");
  });

  it("toStored 缺 message_seq 时 seq 为 null", () => {
    expect(toStored(groupEvent({ message_seq: undefined }), "999")?.seq).toBeNull();
  });

  it("extractCommand 剥掉 @ 与命令", () => {
    expect(extractCommand(segmentsOf(groupEvent()), "999", "/pi")).toEqual({ text: "你好pi-agent", replyTo: null });
  });

  it("extractCommand 拒绝前缀误匹配 /pizza", () => {
    expect(extractCommand([at("999"), text(" /pizza")], "999", "/pi")).toBeNull();
  });

  it("requireMention=false 时无需 @ 即可命中", () => {
    expect(extractCommand([text("/pi 你好")], "999", "/pi", { requireMention: false })).toEqual({ text: "你好", replyTo: null });
    expect(extractCommand([text(" /pizza")], "999", "/pi", { requireMention: false })).toBeNull();
  });

  it("requireMention=true（默认）时无 @ 不命中", () => {
    expect(extractCommand([text("/pi 你好")], "999", "/pi")).toBeNull();
    expect(extractCommand([text("/pi 你好")], "999", "/pi", { requireMention: true })).toBeNull();
  });

  it("extractCommand 空正文返回 null", () => {
    expect(extractCommand([at("999"), text(" /pi   ")], "999", "/pi")).toBeNull();
  });

  it("fromApiMessage 转换 get_msg/history 结果（含 seq）", () => {
    const stored = fromApiMessage(
      { message_id: 700, message_seq: 4999, time: 1, sender: { user_id: 42, nickname: "李四" }, message: [text("被引用的原文")] },
      "123",
    );
    expect(stored).toMatchObject({ groupId: "123", messageId: "700", seq: 4999, text: "被引用的原文", senderName: "李四" });
  });
});

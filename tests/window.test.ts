import { describe, expect, it } from "vitest";
import { collectWindow } from "../src/bridge/window";
import { MessageStore } from "../src/store/db";
import type { StoredMessage } from "../src/types";

function msg(id: string, seq: number, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    groupId: "123",
    messageId: id,
    seq,
    userId: "42",
    senderName: "张三",
    text: `m${id}`,
    replyTo: null,
    ts,
    isSelf: false,
    attachments: [],
    ...extra,
  };
}

const config = { recent: 3, quotedBefore: 2, quotedAfter: 1, maxMessages: 10 };

describe("collectWindow（R9）", () => {
  it("引用早于最近窗口时按 seq 补采并合并排序", async () => {
    const store = new MessageStore(":memory:");
    for (const m of [msg("10", 110, 1100), msg("11", 111, 1110), msg("12", 112, 1120)]) store.insert(m);
    const history = async () => [msg("7", 107, 1070), msg("8", 108, 1080), msg("9", 109, 1090)];
    const rows = await collectWindow({ config, groupId: "123", quoted: msg("8", 108, 1080), store, history });
    expect(rows.map((m) => m.messageId)).toEqual(["7", "8", "9", "10", "11", "12"]);
  });

  it("重叠消息按 messageId 去重，只出现一次", async () => {
    const store = new MessageStore(":memory:");
    for (const m of [msg("1", 101, 1010), msg("2", 102, 1020), msg("3", 103, 1030), msg("4", 104, 1040)]) store.insert(m);
    const history = async () => [msg("1", 101, 1010), msg("2", 102, 1020), msg("3", 103, 1030)];
    const rows = await collectWindow({
      config: { recent: 2, quotedBefore: 2, quotedAfter: 1, maxMessages: 10 },
      groupId: "123",
      quoted: msg("1", 101, 1010),
      store,
      history,
    });
    expect(rows.map((m) => m.messageId)).toEqual(["1", "2", "3", "4"]);
    expect(rows.filter((m) => m.messageId === "3")).toHaveLength(1);
  });

  it("超过 maxMessages 时保留引用消息与最新尾部", async () => {
    const store = new MessageStore(":memory:");
    for (let i = 1; i <= 10; i += 1) store.insert(msg(String(i), 100 + i, 1000 + i));
    const rows = await collectWindow({
      config: { recent: 10, quotedBefore: 0, quotedAfter: 0, maxMessages: 4 },
      groupId: "123",
      quoted: msg("2", 102, 1002),
      store,
    });
    expect(rows.map((m) => m.messageId)).toEqual(["2", "8", "9", "10"]);
  });

  it("没有引用时只用最近窗口（不调 history）", async () => {
    const store = new MessageStore(":memory:");
    for (const m of [msg("1", 101, 1010), msg("2", 102, 1020)]) store.insert(m);
    let called = 0;
    const rows = await collectWindow({
      config,
      groupId: "123",
      quoted: null,
      store,
      history: async () => {
        called += 1;
        return [];
      },
    });
    expect(called).toBe(0);
    expect(rows.map((m) => m.messageId)).toEqual(["1", "2"]);
  });
});

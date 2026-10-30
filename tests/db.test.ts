import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageStore } from "../src/store/db";
import type { StoredMessage } from "../src/types";

function msg(id: string, seq: number | null, ts: number, extra: Partial<StoredMessage> = {}): StoredMessage {
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

describe("MessageStore", () => {
  it("recent 返回最后 N 条且按时间升序", () => {
    const store = new MessageStore(":memory:");
    store.insert(msg("1", 1, 100));
    store.insert(msg("2", 2, 200));
    store.insert(msg("3", 3, 300));
    expect(store.recent("123", 2).map((m) => m.messageId)).toEqual(["2", "3"]);
  });

  it("同一 message_id 重复插入不产生重复行", () => {
    const store = new MessageStore(":memory:");
    store.insert(msg("1", 1, 100));
    store.insert(msg("1", 1, 100, { text: "改过" }));
    const rows = store.recent("123", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("改过");
  });

  it("get 命中返回，未命中返回 undefined", () => {
    const store = new MessageStore(":memory:");
    store.insert(msg("1", 1, 100));
    expect(store.get("123", "1")?.text).toBe("m1");
    expect(store.get("123", "404")).toBeUndefined();
  });

  it("attachments 以 JSON 往返（含 cachedPath）", () => {
    const store = new MessageStore(":memory:");
    const attachment = {
      kind: "image" as const,
      name: "a.jpg",
      fileId: null,
      url: "https://x/a.jpg",
      path: null,
      cachedPath: "C:/cache/ab/x.jpg",
      bytes: 10,
    };
    store.insert(msg("1", 1, 100, { attachments: [attachment] }));
    expect(store.get("123", "1")?.attachments).toEqual([attachment]);
  });

  it("windowAround 按 seq 区间取（升序），无 seq 的行不参与", () => {
    const store = new MessageStore(":memory:");
    for (const [id, seq] of [["1", 100], ["2", 101], ["3", 102], ["4", null]] as const) {
      store.insert(msg(String(id), seq as number | null, Number(id)));
    }
    expect(store.windowAround("123", 100, 101).map((m) => m.messageId)).toEqual(["1", "2"]);
  });

  it("prune 只保留最近 N 条", () => {
    const store = new MessageStore(":memory:");
    for (const id of ["1", "2", "3", "4"]) store.insert(msg(id, Number(id), Number(id)));
    expect(store.prune("123", 2)).toBe(2);
    expect(store.recent("123", 10).map((m) => m.messageId)).toEqual(["3", "4"]);
  });

  it("父目录不存在时自动创建（真实文件路径）", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-db-")), "nested", "messages.db");
    const store = new MessageStore(path);
    store.insert(msg("1", 1, 100));
    expect(store.recent("123", 1)).toHaveLength(1);
    store.close();
  });

  it("不同群互不干扰", () => {
    const store = new MessageStore(":memory:");
    store.insert(msg("1", 1, 100));
    store.insert(msg("2", 2, 200, { groupId: "456" }));
    expect(store.recent("123", 10).map((m) => m.messageId)).toEqual(["1"]);
    expect(store.recent("456", 10).map((m) => m.messageId)).toEqual(["2"]);
  });
});

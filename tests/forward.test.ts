import { describe, expect, it, vi } from "vitest";
import { chunkText, expandForward, renderForward } from "../src/llbot/forward";

describe("renderForward / expandForward（入向合并转发）", () => {
  it("把节点渲染成多行文本并带条数头", () => {
    const text = renderForward([
      { sender: { nickname: "张三", user_id: 42 }, content: [{ type: "text", data: { text: "早" } }] },
      { sender: { nickname: "李四", user_id: 7 }, content: [{ type: "text", data: { text: "[图片]" } }, { type: "text", data: { text: "看图" } }] },
    ]);
    expect(text).toContain("[合并转发聊天记录 · 2 条]");
    expect(text).toContain("张三: 早");
    expect(text).toContain("李四: [图片]看图");
  });

  it("content 为字符串时也能渲染", () => {
    expect(renderForward([{ sender: { nickname: "A" }, content: "纯文本" }])).toContain("A: 纯文本");
  });

  it("expandForward 调用 get_forward_msg 并渲染", async () => {
    const call = vi.fn(async () => ({ messages: [{ sender: { nickname: "张三" }, content: "hi" }] }));
    const text = await expandForward("fwd-1", { call });
    expect(call).toHaveBeenCalledWith("get_forward_msg", { id: "fwd-1" });
    expect(text).toContain("张三: hi");
  });

  it("expandForward 失败或空返回 null，不抛", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await expandForward("x", { call: failing })).toBeNull();
    expect(await expandForward("y", { call: async () => ({ messages: [] }) })).toBeNull();
  });

  it("chunkText 按长度切分并尽量在换行处切", () => {
    expect(chunkText("abcdef", 3)).toEqual(["abc", "def"]);
    const text = "aaa\nbbb\nccc";
    const chunks = chunkText(text, 5);
    expect(chunks.every((chunk) => chunk.length <= 5)).toBe(true);
    expect(chunks.join("")).toContain("aaa");
    expect(chunks.join("")).toContain("ccc");
  });
});

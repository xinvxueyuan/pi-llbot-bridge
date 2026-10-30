import { describe, expect, it } from "vitest";
import { renderSegment, renderText } from "../src/llbot/parse";

describe("renderSegment（R10）", () => {
  it("文本原样、@ 保留", () => {
    expect(renderSegment({ type: "text", data: { text: "看这个" } })).toBe("看这个");
    expect(renderSegment({ type: "at", data: { qq: "999" } })).toBe("@999");
    expect(renderSegment({ type: "at", data: { qq: "all" } })).toBe("@全体成员");
  });

  it("图片/语音/视频/卡片/合并转发 → 固定占位", () => {
    expect(renderSegment({ type: "image", data: {} })).toBe("[图片]");
    expect(renderSegment({ type: "record", data: {} })).toBe("[语音]");
    expect(renderSegment({ type: "video", data: {} })).toBe("[视频]");
    expect(renderSegment({ type: "json", data: {} })).toBe("[卡片]");
    expect(renderSegment({ type: "forward", data: {} })).toBe("[合并转发]");
  });

  it("群文件带文件名，不泄漏原始字段", () => {
    expect(renderSegment({ type: "file", data: { name: "讲义.pdf", file_id: "abc" } })).toBe("[群文件:讲义.pdf]");
    expect(renderSegment({ type: "file", data: {} })).toBe("[群文件]");
  });

  it("表情包带名称，普通表情带 id", () => {
    expect(renderSegment({ type: "mface", data: { summary: "[猫猫]" } })).toBe("[表情包:[猫猫]]");
    expect(renderSegment({ type: "mface", data: {} })).toBe("[表情包]");
    expect(renderSegment({ type: "face", data: { id: "14" } })).toBe("[表情:14]");
  });

  it("reply 段跳过、未知类型降级为类型名", () => {
    expect(renderSegment({ type: "reply", data: { id: 1 } })).toBeNull();
    expect(renderSegment({ type: "weird_type", data: {} })).toBe("[weird_type]");
    expect(
      renderText([
        { type: "at", data: { qq: "1" } },
        { type: "text", data: { text: " hi" } },
        { type: "image", data: {} },
      ]),
    ).toBe("@1 hi[图片]");
  });
});

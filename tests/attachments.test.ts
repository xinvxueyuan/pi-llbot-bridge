import { describe, expect, it } from "vitest";
import { collectAttachments, toStored } from "../src/llbot/parse";
import type { ObEvent } from "../src/types";

describe("collectAttachments（R12）", () => {
  it("图片/文件/视频/语音都被提取，字段映射正确", () => {
    const list = collectAttachments([
      { type: "image", data: { file: "a.jpg", url: "https://x/a.jpg", file_size: "1234" } },
      { type: "file", data: { name: "讲义.pdf", file: "讲义.pdf", file_id: "uuid-1", path: "C:/QQ/讲义.pdf", file_size: "2048" } },
      { type: "video", data: { file: "v.mp4", path: "C:/QQ/v.mp4" } },
      { type: "record", data: { file: "r.amr" } },
    ]);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ kind: "image", name: "a.jpg", url: "https://x/a.jpg", bytes: 1234, cachedPath: null });
    expect(list[1]).toMatchObject({ kind: "file", name: "讲义.pdf", fileId: "uuid-1", path: "C:/QQ/讲义.pdf", bytes: 2048 });
    expect(list[2]).toMatchObject({ kind: "video", name: "v.mp4", path: "C:/QQ/v.mp4" });
    expect(list[3]).toMatchObject({ kind: "record", name: "r.amr" });
  });

  it("合并转发段产生 kind=forward 的附件（fileId 是转发 id）", () => {
    const list = collectAttachments([{ type: "forward", data: { id: "fwd-123" } }]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "forward", fileId: "fwd-123" });
  });

  it("文本/表情/回复段不产生附件", () => {
    expect(
      collectAttachments([
        { type: "text", data: { text: "hi" } },
        { type: "face", data: { id: "1" } },
        { type: "reply", data: { id: 1 } },
      ]),
    ).toEqual([]);
  });

  it("缺名字时用 kind-序号兜底，未知类型不崩", () => {
    const list = collectAttachments([{ type: "image", data: {} }, { type: "weird", data: {} }]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("image-0");
  });

  it("toStored 把附件挂到消息上", () => {
    const event: ObEvent = {
      post_type: "message",
      message_type: "group",
      group_id: 1,
      user_id: 2,
      message_id: 3,
      time: 4,
      sender: { nickname: "张三" },
      message: [{ type: "text", data: { text: "看图" } }, { type: "image", data: { file: "b.png", url: "https://x/b.png" } }],
    };
    expect(toStored(event, "999")?.attachments).toHaveLength(1);
    expect(toStored(event, "999")?.attachments[0]).toMatchObject({ kind: "image", name: "b.png" });
  });
});

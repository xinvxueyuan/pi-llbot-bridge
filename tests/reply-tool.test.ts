import { describe, expect, it } from "vitest";
import { makeReplyTool } from "../src/tools/reply";
import type { Bridge } from "../src/bridge/bridge";

const fakeBridge = (result: { sent: boolean; count: number }) => ({ reply: async () => result }) as unknown as Bridge;

describe("qq_reply tool", () => {
  it("有桥时调用 bridge.reply 并回报已发送", async () => {
    const tool = makeReplyTool(() => fakeBridge({ sent: true, count: 1 }));
    const result = await tool.execute("call-1", { text: "答复" }, undefined, undefined, undefined as never);
    expect(String((result.content[0] as { text: string }).text)).toContain("已发送");
    expect(result.details).toEqual({ sent: true, count: 1 });
  });

  it("桥未启动时明确告知未发送", async () => {
    const tool = makeReplyTool(() => null);
    const result = await tool.execute("call-2", { text: "答复" }, undefined, undefined, undefined as never);
    expect(String((result.content[0] as { text: string }).text)).toContain("未启动");
    expect(result.details).toEqual({ sent: false, count: 0 });
  });
});

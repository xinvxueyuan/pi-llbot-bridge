import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Bridge } from "../bridge/bridge";

export function makeReplyTool(getBridge: () => Bridge | null) {
  return defineTool({
    name: "qq_reply",
    label: "QQ 回复",
    description: "把本次请求的最终答复发回发起请求的 QQ 群。每轮请求只调用一次；内容直接面向群友，纯文本，可换行。",
    parameters: Type.Object({
      text: Type.String({ description: "要发送到群里的完整答复文本" }),
    }),
    async execute(_toolCallId, params) {
      const bridge = getBridge();
      if (!bridge) {
        return {
          content: [{ type: "text" as const, text: "LLBot 桥未启动，无法发送。" }],
          details: { sent: false, count: 0 },
        };
      }
      const result = await bridge.reply(params.text);
      return {
        content: [
          {
            type: "text" as const,
            text: result.sent ? `已发送到 QQ 群（本轮第 ${result.count} 条）` : "当前没有待回复的 QQ 请求，未发送。",
          },
        ],
        details: result,
      };
    },
  });
}

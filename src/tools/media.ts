import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Bridge, SendResult } from "../bridge/bridge";

const REASON_TEXT: Record<string, string> = {
  "no-turn": "当前没有待回复的 QQ 请求，未发送。",
  limit: "本轮已达到发送条数上限，未发送。",
  disabled: "配置里关闭了媒体上传，未发送。",
  missing: "文件不存在，未发送。",
  "too-large": "文件超过单文件上限，未发送。",
  "send-failed": "发送失败（QQ 侧报错），未发送。",
};

export function makeMediaTool(getBridge: () => Bridge | null) {
  return defineTool({
    name: "qq_send_media",
    label: "QQ 发送媒体",
    description:
      "把本机上的图片或文件发送到当前 QQ 群。path 必须是本机绝对路径；kind=image 走图片消息，kind=file 走群文件上传。",
    parameters: Type.Object({
      path: Type.String({ description: "本机绝对路径，例如 C:/Users/me/chart.png" }),
      kind: Type.Union([Type.Literal("image"), Type.Literal("file")], { description: "image=图片消息，file=群文件" }),
      name: Type.Optional(Type.String({ description: "群文件显示名（仅 kind=file 有效）" })),
    }),
    async execute(_toolCallId, params) {
      const bridge = getBridge();
      if (!bridge) {
        const details: SendResult = { sent: false, count: 0, reason: "no-turn" };
        return { content: [{ type: "text" as const, text: "LLBot 桥未启动，无法发送。" }], details };
      }
      const result = await bridge.sendMedia({ path: params.path, kind: params.kind, name: params.name });
      const text = result.sent
        ? `已发送到 QQ 群（本轮第 ${result.count} 条）`
        : (REASON_TEXT[result.reason ?? ""] ?? "未发送。");
      return { content: [{ type: "text" as const, text }], details: result };
    },
  });
}

import type { StoredMessage } from "../types";

export interface PromptAttachment {
  kind: string;
  name: string;
  path: string;
  from: string;
}

export interface PromptInput {
  turnId: string;
  selfName: string;
  groupId: string;
  requester: string;
  request: string;
  transcript: string;
  quoted: StoredMessage | null;
  attachments: PromptAttachment[];
}

export function buildPrompt(input: PromptInput): string {
  const lines: string[] = [];
  lines.push(`[pi-llbot turn:${input.turnId}]`);
  lines.push(`你是 QQ 群 ${input.groupId} 里的机器人 ${input.selfName}，现在收到一条 @ 你的请求。`);
  lines.push("");
  lines.push("群聊上下文（已筛选，按时间顺序）：");
  lines.push(input.transcript || "（无可用上下文）");
  if (input.quoted) {
    lines.push("");
    lines.push(`[被引用的消息] ${input.quoted.senderName}(${input.quoted.userId}): ${input.quoted.text}`);
  }
  if (input.attachments.length > 0) {
    lines.push("");
    lines.push("[本地附件]（已缓存到本机，可直接读取路径）");
    for (const attachment of input.attachments) {
      lines.push(`- ${attachment.from} 的${attachment.kind}「${attachment.name}」→ ${attachment.path}`);
    }
  }
  lines.push("");
  lines.push(`[本次请求] ${input.requester}: ${input.request}`);
  lines.push("");
  lines.push(
    "请完成上面的请求，然后必须调用 qq_reply 工具把最终答复发回群里（本轮只调用一次；内容直接面向群友，不要提到工具名或内部细节）。",
  );
  return lines.join("\n");
}

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
  maxReplies: number;
  mediaUpload: boolean;
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
  const replyRule =
    input.maxReplies < 0
      ? "可以分多条发送，不限条数"
      : input.maxReplies === 0
        ? "本轮不要发送任何消息"
        : `最多发送 ${input.maxReplies} 条消息`;
  lines.push(
    `请完成上面的请求，然后调用 qq_reply 把答复发回群里（${replyRule}；内容直接面向群友，不要提到工具名或内部细节）。`,
  );
  if (input.mediaUpload) {
    lines.push("需要发图片或文件时，用 qq_send_media 工具，path 传本机绝对路径（可以用你刚生成的文件或上面列出的本地附件）。");
  }
  return lines.join("\n");
}

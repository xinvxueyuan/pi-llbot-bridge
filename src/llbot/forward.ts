import { renderText } from "./parse";
import type { ObSegment } from "../types";

export interface ForwardDeps {
  call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string) => void;
}

interface ForwardNode {
  sender?: { nickname?: string; user_id?: number | string };
  time?: number;
  content?: ObSegment[] | string;
}

/** 把 get_forward_msg 的 nodes 渲染成多行文本。 */
export function renderForward(nodes: ForwardNode[], limit = 50): string {
  const lines: string[] = [];
  for (const node of nodes.slice(0, limit)) {
    const sender = node.sender ?? {};
    const who = String(sender.nickname ?? sender.user_id ?? "未知");
    const segments = Array.isArray(node.content)
      ? node.content
      : typeof node.content === "string"
        ? [{ type: "text", data: { text: node.content } }]
        : [];
    const text = renderText(segments as ObSegment[]);
    if (text) lines.push(`${who}: ${text}`);
  }
  const header = `[合并转发聊天记录 · ${Math.min(nodes.length, limit)} 条]`;
  return [header, ...lines].join("\n");
}

/** 拉取并渲染一条合并转发；失败返回 null（调用方退回占位符）。 */
export async function expandForward(id: string, deps: ForwardDeps, limit = 50): Promise<string | null> {
  try {
    const data = (await deps.call("get_forward_msg", { id })) as { messages?: ForwardNode[] } | null;
    const nodes = data?.messages ?? [];
    if (nodes.length === 0) return null;
    return renderForward(nodes, limit);
  } catch (error) {
    deps.log?.(`展开合并转发失败(${id})：${(error as Error).message}`);
    return null;
  }
}

/** 把长文本切成不超过 size 的块（尽量在换行处切）。 */
export function chunkText(text: string, size: number): string[] {
  if (size <= 0 || text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

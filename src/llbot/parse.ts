import type { Attachment, AttachmentKind, ObEvent, ObSegment, StoredMessage } from "../types";

const MEDIA_PLACEHOLDER: Record<string, string> = {
  record: "[语音]",
  video: "[视频]",
  json: "[卡片]",
  markdown: "[卡片]",
  forward: "[合并转发]",
  node: "[合并转发]",
  dice: "[骰子]",
  rps: "[猜拳]",
};

const ATTACHMENT_KINDS: Record<string, AttachmentKind> = {
  image: "image",
  file: "file",
  video: "video",
  record: "record",
};

export function segmentsOf(event: ObEvent): ObSegment[] {
  if (Array.isArray(event.message)) return event.message;
  if (typeof event.message === "string") return [{ type: "text", data: { text: event.message } }];
  return [];
}

export function renderSegment(segment: ObSegment): string | null {
  const data = segment.data ?? {};
  switch (segment.type) {
    case "text":
      return String(data.text ?? "");
    case "at": {
      const qq = String(data.qq ?? "");
      return qq === "all" ? "@全体成员" : `@${qq}`;
    }
    case "reply":
      return null;
    case "image": {
      const name = data.file ?? data.summary;
      return name ? `[图片:${String(name)}]` : "[图片]";
    }
    case "mface": {
      const name = data.summary;
      return name ? `[表情包:${String(name)}]` : "[表情包]";
    }
    case "face": {
      const id = data.id;
      return id === undefined || id === null ? "[表情]" : `[表情:${String(id)}]`;
    }
    case "file": {
      const name = data.name ?? data.file;
      return name ? `[群文件:${String(name)}]` : "[群文件]";
    }
    default:
      return MEDIA_PLACEHOLDER[segment.type] ?? `[${segment.type}]`;
  }
}

export function renderText(segments: ObSegment[]): string {
  return segments
    .map(renderSegment)
    .filter((part): part is string => part !== null)
    .join("")
    .trim();
}

export function replyTarget(segments: ObSegment[]): string | null {
  const segment = segments.find((item) => item.type === "reply");
  const id = segment?.data?.id;
  return id === undefined || id === null ? null : String(id);
}

export function mentions(segments: ObSegment[], selfId: string): boolean {
  return segments.some((segment) => segment.type === "at" && String(segment.data?.qq ?? "") === selfId);
}

export function collectAttachments(segments: ObSegment[]): Attachment[] {
  const attachments: Attachment[] = [];
  for (const segment of segments) {
    const kind = ATTACHMENT_KINDS[segment.type];
    if (!kind) continue;
    const data = segment.data ?? {};
    const name = String(data.name ?? data.file ?? `${kind}-${attachments.length}`);
    attachments.push({
      kind,
      name,
      fileId: data.file_id === undefined || data.file_id === null ? null : String(data.file_id),
      url: data.url === undefined || data.url === null || data.url === "" ? null : String(data.url),
      path: data.path === undefined || data.path === null || data.path === "" ? null : String(data.path),
      cachedPath: null,
      bytes: data.file_size === undefined || data.file_size === null ? null : Number(data.file_size),
    });
  }
  return attachments;
}

function toSeq(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function displayName(event: ObEvent): string {
  const sender = event.sender ?? {};
  return String(sender.card || sender.nickname || sender.user_id || event.user_id || "未知");
}

export function toStored(event: ObEvent, selfId: string): StoredMessage | null {
  const isMessage = event.post_type === "message" || event.post_type === "message_sent";
  if (!isMessage || event.message_type !== "group") return null;
  const groupId = String(event.group_id ?? "");
  const messageId = String(event.message_id ?? "");
  if (!groupId || !messageId) return null;
  const segments = segmentsOf(event);
  return {
    groupId,
    messageId,
    seq: toSeq(event.message_seq),
    userId: String(event.user_id ?? event.sender?.user_id ?? ""),
    senderName: displayName(event),
    text: renderText(segments),
    replyTo: replyTarget(segments),
    ts: Number(event.time ?? Math.floor(Date.now() / 1000)),
    isSelf: String(event.user_id ?? "") === selfId,
    attachments: collectAttachments(segments),
  };
}

export interface CommandHit {
  text: string;
  replyTo: string | null;
}

export function extractCommand(
  segments: ObSegment[],
  selfId: string,
  command: string,
  options: { requireMention?: boolean } = {},
): CommandHit | null {
  const requireMention = options.requireMention ?? true;
  if (requireMention && !mentions(segments, selfId)) return null;
  const joined = segments.filter((s) => s.type === "text").map((s) => String(s.data?.text ?? "")).join("");
  const trimmed = joined.replace(/^[\s\u3000]+/, "");
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}(\\s|$)`).exec(trimmed);
  if (!match) return null;
  const rest = trimmed.slice(match[0].length).trim();
  if (!rest) return null;
  return { text: rest, replyTo: replyTarget(segments) };
}

export function fromApiMessage(data: Record<string, unknown>, groupId: string): StoredMessage | null {
  const messageId = data.message_id ?? data.messageId;
  if (messageId === undefined || messageId === null) return null;
  const segments = Array.isArray(data.message) ? (data.message as ObSegment[]) : [];
  const sender = (data.sender ?? {}) as Record<string, unknown>;
  return {
    groupId,
    messageId: String(messageId),
    seq: toSeq(data.message_seq ?? data.messageSeq),
    userId: String(sender.user_id ?? data.user_id ?? ""),
    senderName: String(sender.card || sender.nickname || sender.user_id || "未知"),
    text: renderText(segments),
    replyTo: replyTarget(segments),
    ts: Number(data.time ?? Math.floor(Date.now() / 1000)),
    isSelf: false,
    attachments: collectAttachments(segments),
  };
}

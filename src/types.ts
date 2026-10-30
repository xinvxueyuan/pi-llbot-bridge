export interface ObSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface ObEvent {
  post_type?: string;
  message_type?: string;
  self_id?: number | string;
  time?: number;
  group_id?: number | string;
  user_id?: number | string;
  message_id?: number | string;
  message_seq?: number | string;
  message?: ObSegment[] | string;
  sender?: { user_id?: number | string; nickname?: string; card?: string };
}

export type AttachmentKind = "image" | "file" | "video" | "record";

export interface Attachment {
  kind: AttachmentKind;
  name: string;
  fileId: string | null;
  url: string | null;
  path: string | null;
  cachedPath: string | null;
  bytes: number | null;
}

export interface StoredMessage {
  groupId: string;
  messageId: string;
  seq: number | null;
  userId: string;
  senderName: string;
  text: string;
  replyTo: string | null;
  ts: number;
  isSelf: boolean;
  attachments: Attachment[];
}

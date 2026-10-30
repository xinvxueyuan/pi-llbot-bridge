import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Attachment, StoredMessage } from "../types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER,
  user_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  ts INTEGER NOT NULL,
  is_self INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (group_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages (group_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_group_seq ON messages (group_id, seq);
`;

const COLUMNS = "group_id, message_id, seq, user_id, sender_name, text, reply_to, ts, is_self, attachments";

interface Row {
  group_id: string;
  message_id: string;
  seq: number | null;
  user_id: string;
  sender_name: string;
  text: string;
  reply_to: string | null;
  ts: number;
  is_self: number;
  attachments: string;
}

function parseAttachments(raw: string): Attachment[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as Attachment[]) : [];
  } catch {
    return [];
  }
}

function toStored(row: Row): StoredMessage {
  return {
    groupId: row.group_id,
    messageId: row.message_id,
    seq: row.seq === null ? null : Number(row.seq),
    userId: row.user_id,
    senderName: row.sender_name,
    text: row.text,
    replyTo: row.reply_to,
    ts: Number(row.ts),
    isSelf: Number(row.is_self) === 1,
    attachments: parseAttachments(row.attachments),
  };
}

export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  insert(message: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, message_id) DO UPDATE SET
           seq = excluded.seq, user_id = excluded.user_id, sender_name = excluded.sender_name,
           text = excluded.text, reply_to = excluded.reply_to, ts = excluded.ts,
           is_self = excluded.is_self, attachments = excluded.attachments`,
      )
      .run(
        message.groupId,
        message.messageId,
        message.seq,
        message.userId,
        message.senderName,
        message.text,
        message.replyTo,
        message.ts,
        message.isSelf ? 1 : 0,
        JSON.stringify(message.attachments),
      );
  }

  recent(groupId: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE group_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(groupId, limit) as unknown as Row[];
    return rows.reverse().map(toStored);
  }

  get(groupId: string, messageId: string): StoredMessage | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE group_id = ? AND message_id = ?`)
      .get(groupId, messageId) as unknown as Row | undefined;
    return row ? toStored(row) : undefined;
  }

  windowAround(groupId: string, minSeq: number, maxSeq: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM messages
         WHERE group_id = ? AND seq IS NOT NULL AND seq BETWEEN ? AND ?
         ORDER BY seq ASC`,
      )
      .all(groupId, minSeq, maxSeq) as unknown as Row[];
    return rows.map(toStored);
  }

  prune(groupId: string, keep: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM messages
         WHERE group_id = ?
           AND message_id NOT IN (
             SELECT message_id FROM messages WHERE group_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?
           )`,
      )
      .run(groupId, groupId, keep);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

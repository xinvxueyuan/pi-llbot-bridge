import type { MessageStore } from "../store/db";
import type { StoredMessage } from "../types";

export interface WindowConfig {
  recent: number;
  quotedBefore: number;
  quotedAfter: number;
  maxMessages: number;
}

export interface WindowInput {
  config: WindowConfig;
  groupId: string;
  quoted: StoredMessage | null;
  store: Pick<MessageStore, "recent" | "insert" | "windowAround">;
  history?: (args: { groupId: string; messageSeq: number; count: number }) => Promise<StoredMessage[]>;
  log?: (message: string) => void;
}

function dedupe(messages: StoredMessage[]): StoredMessage[] {
  const seen = new Map<string, StoredMessage>();
  for (const message of messages) if (!seen.has(message.messageId)) seen.set(message.messageId, message);
  return [...seen.values()].sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));
}

export async function collectWindow(input: WindowInput): Promise<StoredMessage[]> {
  const { config, groupId, quoted, store } = input;
  const recent = store.recent(groupId, config.recent);
  if (!quoted || quoted.seq === null) return dedupe(recent).slice(-config.maxMessages);

  const quotedSeq = quoted.seq;
  const covered =
    recent.some((m) => m.messageId === quoted.messageId) && recent.some((m) => m.seq !== null && m.seq < quotedSeq);

  if (!covered && input.history) {
    try {
      const fetched = await input.history({
        groupId,
        messageSeq: quotedSeq,
        count: config.quotedBefore + config.quotedAfter + 1,
      });
      for (const message of fetched) store.insert(message);
    } catch (error) {
      input.log?.(`补采引用上下文失败：${(error as Error).message}`);
    }
  }

  const around = store.windowAround(groupId, quotedSeq - config.quotedBefore, quotedSeq + config.quotedAfter);
  const merged = dedupe([...recent, ...around, quoted]);
  if (merged.length <= config.maxMessages) return merged;

  const quotedMessage = merged.find((m) => m.messageId === quoted.messageId);
  const tail = merged.slice(-(config.maxMessages - 1));
  const keep = quotedMessage && !tail.some((m) => m.messageId === quotedMessage.messageId) ? [quotedMessage, ...tail] : tail;
  return dedupe(keep).slice(0, config.maxMessages);
}

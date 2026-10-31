import type { Attachment, StoredMessage } from "../types";

export interface PrefetchDeps {
  fetch: (attachment: Attachment) => Promise<Attachment>;
  save: (message: StoredMessage, attachments: Attachment[]) => void;
  concurrency?: number;
  shouldFetch?: (attachment: Attachment) => boolean;
  log?: (message: string) => void;
}

/**
 * 收到消息就立刻把附件拉进缓存（QQ 的图片直链带 rkey、几分钟就过期，
 * 拖到「用户发命令时」再下往往已经 403）。
 */
export class MediaPrefetcher {
  private readonly queue: StoredMessage[] = [];
  private readonly queued = new Set<string>();
  private readonly done = new Set<string>();
  private running = 0;

  constructor(private readonly deps: PrefetchDeps) {}

  get pending(): number {
    return this.queue.length + this.running;
  }

  enqueue(message: StoredMessage): void {
    const candidates = message.attachments.filter(
      (attachment) => attachment.kind !== "forward" && !attachment.cachedPath && (this.deps.shouldFetch?.(attachment) ?? true),
    );
    if (candidates.length === 0) return;
    const key = this.keyOf(message);
    if (this.queued.has(key) || this.done.has(key)) return;
    this.queued.add(key);
    this.queue.push(message);
    this.pump();
  }

  async drain(): Promise<void> {
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private keyOf(message: StoredMessage): string {
    return `${message.groupId}:${message.messageId}`;
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? 3;
    while (this.running < limit && this.queue.length > 0) {
      const message = this.queue.shift()!;
      this.running += 1;
      void this.run(message).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(message: StoredMessage): Promise<void> {
    const key = this.keyOf(message);
    const updated: Attachment[] = [];
    let changed = false;

    for (const attachment of message.attachments) {
      if (attachment.kind === "forward" || attachment.cachedPath) {
        updated.push(attachment);
        continue;
      }
      if (this.deps.shouldFetch && !this.deps.shouldFetch(attachment)) {
        updated.push(attachment);
        continue;
      }
      try {
        let fetched = await this.deps.fetch(attachment);
        if (!fetched.cachedPath) {
          // 直链偶发 403/超时：隔一下再试一次（QQ CDN 抖动很常见）
          await new Promise((resolve) => setTimeout(resolve, 800));
          fetched = await this.deps.fetch(attachment);
        }
        updated.push(fetched);
        if (fetched.cachedPath && fetched.cachedPath !== attachment.cachedPath) changed = true;
      } catch (error) {
        updated.push(attachment);
        this.deps.log?.(`预取失败(${attachment.name})：${(error as Error).message}`);
      }
    }

    this.queued.delete(key);
    if (changed) {
      this.done.add(key);
      this.deps.save(message, updated);
    }
  }
}

import { describe, expect, it, vi } from "vitest";
import { MediaPrefetcher } from "../src/media/prefetch";
import type { Attachment, StoredMessage } from "../src/types";

function attachment(name: string, extra: Partial<Attachment> = {}): Attachment {
  return { kind: "image", name, fileId: null, url: `https://x/${name}`, path: null, cachedPath: null, bytes: null, ...extra };
}

function message(id: string, attachments: Attachment[]): StoredMessage {
  return {
    groupId: "123",
    messageId: id,
    seq: Number(id),
    userId: "42",
    senderName: "张三",
    text: "",
    replyTo: null,
    ts: Number(id),
    isSelf: false,
    attachments,
  };
}

describe("MediaPrefetcher（收到即预取）", () => {
  it("收到消息就把附件拉进缓存并回写", async () => {
    const fetchOne = vi.fn(async (a: Attachment) => ({ ...a, cachedPath: `C:/cache/${a.name}` }));
    const save = vi.fn();
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save });
    prefetcher.enqueue(message("1", [attachment("a.jpg")]));
    await prefetcher.drain();
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1][0].cachedPath).toBe("C:/cache/a.jpg");
  });

  it("已缓存 / 合并转发的附件不再拉取", async () => {
    const fetchOne = vi.fn(async (a: Attachment) => a);
    const save = vi.fn();
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save });
    prefetcher.enqueue(message("1", [attachment("a.jpg", { cachedPath: "C:/cache/a.jpg" }), attachment("f", { kind: "forward" })]));
    await prefetcher.drain();
    expect(fetchOne).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("同一条消息重复入队只拉一次", async () => {
    const fetchOne = vi.fn(async (a: Attachment) => ({ ...a, cachedPath: "C:/cache/a.jpg" }));
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save: () => undefined });
    const msg = message("1", [attachment("a.jpg")]);
    prefetcher.enqueue(msg);
    prefetcher.enqueue(msg);
    await prefetcher.drain();
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it("并发受 concurrency 限制", async () => {
    let running = 0;
    let peak = 0;
    const fetchOne = async (a: Attachment) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { ...a, cachedPath: `C:/cache/${a.name}` };
    };
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save: () => undefined, concurrency: 2 });
    for (let i = 0; i < 5; i += 1) prefetcher.enqueue(message(String(i), [attachment(`a${i}.jpg`)]));
    await prefetcher.drain();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("第一次没拿到就重试一次，成功后回写", async () => {
    let attempt = 0;
    const fetchOne = vi.fn(async (a: Attachment) => {
      attempt += 1;
      return attempt === 1 ? a : { ...a, cachedPath: "C:/cache/a.jpg" };
    });
    const save = vi.fn();
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save });
    prefetcher.enqueue(message("1", [attachment("a.jpg")]));
    await prefetcher.drain();
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("两次都失败时不回写，下次入队还能再试", async () => {
    let attempt = 0;
    const fetchOne = vi.fn(async (a: Attachment) => {
      attempt += 1;
      return attempt <= 2 ? a : { ...a, cachedPath: "C:/cache/a.jpg" };
    });
    const save = vi.fn();
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save });
    const msg = message("1", [attachment("a.jpg")]);
    prefetcher.enqueue(msg);
    await prefetcher.drain();
    expect(save).not.toHaveBeenCalled();
    prefetcher.enqueue(msg);
    await prefetcher.drain();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("shouldFetch=false 的附件被跳过", async () => {
    const fetchOne = vi.fn(async (a: Attachment) => a);
    const prefetcher = new MediaPrefetcher({ fetch: fetchOne, save: () => undefined, shouldFetch: () => false });
    prefetcher.enqueue(message("1", [attachment("a.jpg")]));
    await prefetcher.drain();
    expect(fetchOne).not.toHaveBeenCalled();
  });
});

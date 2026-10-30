import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaCache } from "../src/media/cache";

function makeCache(extra: Partial<{ maxFileBytes: number; ttlHours: number; maxTotalBytes: number }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-media-"));
  const cache = new MediaCache({ dir, maxFileBytes: 1024, ttlHours: 1, maxTotalBytes: 4096, ...extra });
  return { cache, dir };
}

describe("MediaCache（R12/R13）", () => {
  it("put 返回内容寻址路径，同内容复用", () => {
    const { cache } = makeCache();
    const first = cache.put(Buffer.from("hello"), "txt");
    const second = cache.put(Buffer.from("hello"), "txt");
    expect(existsSync(first.path)).toBe(true);
    expect(second.path).toBe(first.path);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
  });

  it("超过单文件上限时抛错", () => {
    const { cache } = makeCache({ maxFileBytes: 4 });
    expect(() => cache.put(Buffer.from("12345"), "txt")).toThrow(/单文件上限/);
  });

  it("prune 删除超过 TTL 的文件", () => {
    const { cache } = makeCache({ ttlHours: 1 });
    const { path } = cache.put(Buffer.from("old"), "txt");
    const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(path, twoHoursAgo, twoHoursAgo);
    const result = cache.prune();
    expect(result.removed).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("总量超限时按最旧优先删除", () => {
    const { cache, dir } = makeCache({ ttlHours: 1, maxTotalBytes: 8 });
    const a = cache.put(Buffer.from("aaaa"), "txt");
    const b = cache.put(Buffer.from("bbbb"), "txt");
    const c = cache.put(Buffer.from("cccc"), "txt");
    const nowSec = Math.floor(Date.now() / 1000);
    utimesSync(a.path, nowSec - 30, nowSec - 30);
    utimesSync(b.path, nowSec - 20, nowSec - 20);
    utimesSync(c.path, nowSec - 10, nowSec - 10);
    cache.prune();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(c.path)).toBe(true);
    expect(cache.stats().bytes).toBeLessThanOrEqual(8);
    expect(dir.length).toBeGreaterThan(0);
  });

  it("stats 统计文件数与字节", () => {
    const { cache } = makeCache();
    cache.put(Buffer.from("aa"), "txt");
    cache.put(Buffer.from("bbb"), "txt");
    expect(cache.stats()).toEqual({ files: 2, bytes: 5 });
  });
});

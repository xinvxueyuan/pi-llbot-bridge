import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchAttachment, type FetchDeps } from "../src/media/fetch";
import { MediaCache } from "../src/media/cache";
import type { Attachment } from "../src/types";

function deps(overrides: Partial<FetchDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-fetch-"));
  const cache = new MediaCache({ dir, maxFileBytes: 1024, ttlHours: 1, maxTotalBytes: 1 << 20 });
  const base: FetchDeps = {
    cache,
    maxFileBytes: 1024,
    timeoutMs: 1000,
    call: vi.fn(async () => ({ file: "", url: "" })),
    download: vi.fn(async () => Buffer.from("http-bytes")),
    ...overrides,
  };
  return { cache, deps: base };
}

const base = (extra: Partial<Attachment> = {}): Attachment => ({
  kind: "image",
  name: "a.jpg",
  fileId: null,
  url: null,
  path: null,
  cachedPath: null,
  bytes: null,
  ...extra,
});

describe("fetchAttachment（R12）", () => {
  it("已有本地路径时直接复制进缓存", async () => {
    const source = join(mkdtempSync(join(tmpdir(), "pi-src-")), "a.jpg");
    writeFileSync(source, "local-bytes");
    const { deps: d } = deps();
    const result = await fetchAttachment(base({ path: source }), d);
    expect(result.cachedPath).toMatch(/\.jpg$/);
    expect(d.download).not.toHaveBeenCalled();
  });

  it("http 直链走 download 并缓存", async () => {
    const { deps: d } = deps();
    const result = await fetchAttachment(base({ url: "https://x/a.jpg" }), d);
    expect(d.download).toHaveBeenCalledWith("https://x/a.jpg");
    expect(result.cachedPath).toBeTruthy();
  });

  it("没有 url/path 时用 get_image 兜底", async () => {
    const { deps: d } = deps({ call: vi.fn(async () => ({ file: "C:/QQ/a.jpg", url: "https://x/a.jpg" })) });
    const result = await fetchAttachment(base({ fileId: "uuid-1" }), d);
    expect(d.call).toHaveBeenCalledWith("get_image", { file: "uuid-1", download: true });
    expect(result.cachedPath).toBeTruthy();
  });

  it("下载失败返回原附件且不抛", async () => {
    const { deps: d } = deps({
      download: vi.fn(async () => {
        throw new Error("net down");
      }),
    });
    const result = await fetchAttachment(base({ url: "https://x/a.jpg" }), d);
    expect(result.cachedPath).toBeNull();
  });

  it("超过单文件上限时拒绝并返回原附件", async () => {
    const { deps: d } = deps({ download: vi.fn(async () => Buffer.alloc(4096)), maxFileBytes: 16 });
    const result = await fetchAttachment(base({ url: "https://x/a.jpg" }), d);
    expect(result.cachedPath).toBeNull();
  });
});

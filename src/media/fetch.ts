import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaCache } from "./cache";
import type { Attachment } from "../types";

export interface FetchDeps {
  cache: MediaCache;
  maxFileBytes: number;
  timeoutMs: number;
  call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  download?: (url: string) => Promise<Buffer>;
  log?: (message: string) => void;
}

function extOf(name: string): string {
  const ext = extname(name).replace(".", "").toLowerCase();
  return ext || "bin";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("下载超时")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readSource(attachment: Attachment, deps: FetchDeps): Promise<Buffer | null> {
  if (attachment.path && existsSync(attachment.path)) return readFileSync(attachment.path);

  if (attachment.url && /^https?:/i.test(attachment.url)) {
    if (!deps.download) return null;
    return withTimeout(deps.download(attachment.url), deps.timeoutMs);
  }

  if (attachment.url && attachment.url.startsWith("file://")) {
    const path = fileURLToPath(attachment.url);
    if (existsSync(path)) return readFileSync(path);
  }

  const action = attachment.kind === "image" ? "get_image" : "get_file";
  const key = attachment.fileId ?? attachment.name;
  const data = (await deps.call(action, { file: key, download: true })) as { file?: string; url?: string } | null;
  if (data?.file && existsSync(data.file)) return readFileSync(data.file);
  if (data?.url && /^https?:/i.test(data.url) && deps.download) {
    return withTimeout(deps.download(data.url), deps.timeoutMs);
  }
  return null;
}

export async function fetchAttachment(attachment: Attachment, deps: FetchDeps): Promise<Attachment> {
  if (attachment.cachedPath && existsSync(attachment.cachedPath)) return attachment;

  try {
    const bytes = await readSource(attachment, deps);
    if (!bytes) return attachment;
    if (bytes.length > deps.maxFileBytes) {
      deps.log?.(`附件过大，跳过缓存：${attachment.name}`);
      return attachment;
    }
    const { path } = deps.cache.put(bytes, extOf(attachment.name));
    return { ...attachment, cachedPath: path, bytes: bytes.length };
  } catch (error) {
    deps.log?.(`附件下载失败(${attachment.name})：${(error as Error).message}`);
    return attachment;
  }
}

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
    const timer = setTimeout(() => reject(new Error("超时")), ms);
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

interface SourceResult {
  bytes: Buffer | null;
  error: string;
}

/**
 * 依次尝试：本地路径 → 直链 URL → file:// → 让 LLBot 自己下（get_image/get_file）。
 * 任何一步失败都继续尝试下一步，最后把每步的错误拼起来返回。
 */
async function readSource(attachment: Attachment, deps: FetchDeps): Promise<SourceResult> {
  const errors: string[] = [];

  if (attachment.path && existsSync(attachment.path)) {
    try {
      return { bytes: readFileSync(attachment.path), error: "" };
    } catch (error) {
      errors.push(`local:${(error as Error).message}`);
    }
  }

  if (attachment.url && /^https?:/i.test(attachment.url) && deps.download) {
    try {
      return { bytes: await withTimeout(deps.download(attachment.url), deps.timeoutMs), error: "" };
    } catch (error) {
      errors.push(`url:${(error as Error).message}`);
    }
  }

  if (attachment.url && attachment.url.startsWith("file://")) {
    try {
      const path = fileURLToPath(attachment.url);
      if (existsSync(path)) return { bytes: readFileSync(path), error: "" };
      errors.push("file:// 路径不存在");
    } catch (error) {
      errors.push(`file://:${(error as Error).message}`);
    }
  }

  const action = attachment.kind === "image" ? "get_image" : "get_file";
  const key = attachment.fileId ?? attachment.name;
  try {
    const data = (await withTimeout(deps.call(action, { file: key, download: true }), deps.timeoutMs)) as
      | { file?: string; url?: string }
      | null;
    if (data?.file && existsSync(data.file)) return { bytes: readFileSync(data.file), error: "" };
    if (data?.url && /^https?:/i.test(data.url) && deps.download) {
      try {
        return { bytes: await withTimeout(deps.download(data.url), deps.timeoutMs), error: "" };
      } catch (error) {
        errors.push(`getfile-url:${(error as Error).message}`);
      }
    } else {
      errors.push(`${action}: 没有可用文件`);
    }
  } catch (error) {
    errors.push(`${action}:${(error as Error).message}`);
  }

  return { bytes: null, error: errors.join(" | ") || "没有可用的下载线索" };
}

export async function fetchAttachment(attachment: Attachment, deps: FetchDeps): Promise<Attachment> {
  if (attachment.cachedPath && existsSync(attachment.cachedPath)) return attachment;

  const { bytes, error } = await readSource(attachment, deps);
  if (!bytes) {
    deps.log?.(`附件下载失败(${attachment.kind} ${attachment.name})：${error}`);
    return attachment;
  }
  if (bytes.length > deps.maxFileBytes) {
    deps.log?.(`附件过大，跳过缓存(${attachment.name})：${bytes.length} > ${deps.maxFileBytes}`);
    return attachment;
  }
  try {
    const { path } = deps.cache.put(bytes, extOf(attachment.name));
    return { ...attachment, cachedPath: path, bytes: bytes.length };
  } catch (error2) {
    deps.log?.(`附件写入缓存失败(${attachment.name})：${(error2 as Error).message}`);
    return attachment;
  }
}

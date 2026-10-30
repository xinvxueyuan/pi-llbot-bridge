import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheOptions {
  dir: string;
  maxFileBytes: number;
  ttlHours: number;
  maxTotalBytes: number;
  now?: () => number;
}

export interface PutResult {
  path: string;
  reused: boolean;
}

interface Entry {
  path: string;
  size: number;
  mtimeMs: number;
}

export class MediaCache {
  constructor(private readonly options: CacheOptions) {
    mkdirSync(this.options.dir, { recursive: true });
  }

  get dir(): string {
    return this.options.dir;
  }

  put(bytes: Buffer, ext: string): PutResult {
    if (bytes.length > this.options.maxFileBytes) {
      throw new Error(`超过单文件上限 ${this.options.maxFileBytes} 字节`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const folder = join(this.options.dir, hash.slice(0, 2));
    mkdirSync(folder, { recursive: true });
    const target = join(folder, `${hash}.${ext || "bin"}`);
    if (existsSync(target)) return { path: target, reused: true };
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);
    return { path: target, reused: false };
  }

  prune(): { removed: number; freedBytes: number } {
    const now = this.options.now ? this.options.now() : Date.now();
    const ttlMs = this.options.ttlHours * 3600_000;
    let removed = 0;
    let freedBytes = 0;

    for (const entry of this.entries()) {
      if (ttlMs > 0 && now - entry.mtimeMs > ttlMs) {
        rmSync(entry.path, { force: true });
        removed += 1;
        freedBytes += entry.size;
      }
    }

    const alive = this.entries();
    let total = alive.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of alive.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= this.options.maxTotalBytes) break;
      rmSync(entry.path, { force: true });
      total -= entry.size;
      removed += 1;
      freedBytes += entry.size;
    }

    return { removed, freedBytes };
  }

  stats(): { files: number; bytes: number } {
    const entries = this.entries();
    return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
  }

  private entries(): Entry[] {
    const out: Entry[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.isFile()) {
          const info = statSync(full);
          out.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    walk(this.options.dir);
    return out;
  }
}

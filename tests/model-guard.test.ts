import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("模型护栏（R8）", () => {
  it("src 里不出现任何改模型的调用", () => {
    const banned = ["setModel(", "registerProvider(", "setThinkingLevel(", "setActiveTools("];
    for (const file of sourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      for (const token of banned) {
        expect(source.includes(token), `${file} 出现了 ${token}，违反 R8`).toBe(false);
      }
    }
  });
});

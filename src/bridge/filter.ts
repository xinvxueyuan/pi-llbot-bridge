import type { StoredMessage } from "../types";
import type { FilterConfig } from "../config";

export interface FilterDeps {
  config: FilterConfig;
  complete?: (prompt: string) => Promise<string>;
}

const SYSTEM_PROMPT =
  "你是 QQ 群聊记录筛选器。给定一段群聊记录与用户本次请求，删掉与请求无关的噪声" +
  "（刷屏、表情包/图片/文件占位、无意义寒暄、重复内容），保留理解请求所必需的消息。" +
  "输出格式：每行一条，形如 `HH:MM 昵称: 内容`；不要解释、不要总结成段、不要编造原文没有的内容。";

function clock(ts: number): string {
  const date = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function renderTranscript(messages: StoredMessage[]): string {
  return messages.map((message) => `${clock(message.ts)} ${message.senderName}: ${message.text}`).join("\n");
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.6);
  const tail = Math.max(0, limit - head - 5);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("筛选请求超时")), ms);
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

export async function filterTranscript(messages: StoredMessage[], request: string, deps: FilterDeps): Promise<string> {
  const deterministic = clamp(renderTranscript(messages), deps.config.maxOutputChars);
  if (!deps.config.enabled || !deps.complete) return deterministic;

  const input = clamp(renderTranscript(messages), deps.config.maxInputChars);
  const prompt = `${SYSTEM_PROMPT}\n\n[本次请求]\n${request}\n\n[群聊记录]\n${input}\n\n只输出筛选后的行：`;

  try {
    const output = await withTimeout(deps.complete(prompt), deps.config.timeoutMs);
    const text = output.trim();
    if (!text) return deterministic;
    return clamp(text, deps.config.maxOutputChars);
  } catch {
    return deterministic;
  }
}

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { BridgeConfig } from "../config";
import type { MessageStore } from "../store/db";
import type { ObEvent, StoredMessage } from "../types";
import { extractCommand, fromApiMessage, segmentsOf, toStored } from "../llbot/parse";
import { buildPrompt, type PromptAttachment } from "./prompt";

export interface OneBotLike {
  call<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface TurnState {
  turnId: string;
  groupId: string;
  messageId: string;
  userId: string;
  started: boolean;
  replied: number;
  createdAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ContextInput {
  groupId: string;
  quoted: StoredMessage | null;
  request: string;
}

export interface ContextBundle {
  transcript: string;
  attachments: PromptAttachment[];
}

export interface BridgeDeps {
  config: BridgeConfig;
  store: MessageStore;
  client: OneBotLike;
  sendUserMessage: (prompt: string, attachments: PromptAttachment[], options?: { deliverAs?: "steer" | "followUp" }) => void;
  isIdle: () => boolean;
  collectContext: (input: ContextInput) => Promise<ContextBundle>;
  log?: (message: string) => void;
  now?: () => number;
  makeTurnId?: () => string;
}

export interface SendResult {
  sent: boolean;
  count: number;
  reason?: "no-turn" | "limit" | "disabled" | "missing" | "too-large" | "send-failed";
}

export interface MediaInput {
  path: string;
  kind: "image" | "file";
  name?: string;
}

export interface SettleOutcome {
  aborted: boolean;
  error?: string;
  lastText?: string;
}

export class Bridge {
  selfId = "";
  selfName = "pi";
  private current: TurnState | null = null;
  private readonly seen = new Set<string>();
  private readonly sentIds = new Set<string>();

  constructor(private readonly deps: BridgeDeps) {}

  get turn(): TurnState | null {
    return this.current;
  }

  async handleEvent(event: ObEvent): Promise<void> {
    const isMessage = event.post_type === "message" || event.post_type === "message_sent";
    if (!isMessage || event.message_type !== "group") return;
    const stored = toStored(event, this.selfId);
    if (!stored) return;

    this.deps.store.insert(stored);
    this.deps.store.prune(stored.groupId, this.deps.config.store.keepPerGroup);
    if (stored.isSelf && !this.selfTriggerAllowed(stored.userId)) return;
    if (this.sentIds.has(stored.messageId)) return;
    if (!this.groupAllowed(stored.groupId)) return;

    const hit = extractCommand(segmentsOf(event), this.selfId, this.deps.config.command, {
      requireMention: this.deps.config.trigger.requireMention,
    });
    if (!hit) return;
    if (this.seen.has(stored.messageId)) return;
    this.seen.add(stored.messageId);

    if (this.current) {
      await this.sendText(stored.groupId, "上一条请求还在处理中，请稍后再试。");
      return;
    }

    await this.react(stored.messageId, this.deps.config.reactions.resolving);

    const quoted = await this.resolveQuoted(stored);
    let bundle: ContextBundle = { transcript: "", attachments: [] };
    try {
      bundle = await this.deps.collectContext({ groupId: stored.groupId, quoted, request: hit.text });
    } catch (error) {
      this.deps.log?.(`组上下文失败，降级为空：${(error as Error).message}`);
    }

    const turnId = this.deps.makeTurnId ? this.deps.makeTurnId() : randomUUID();
    const prompt = buildPrompt({
      turnId,
      selfName: this.selfName,
      groupId: stored.groupId,
      requester: `${stored.senderName}(${stored.userId})`,
      request: hit.text,
      transcript: bundle.transcript,
      quoted,
      attachments: bundle.attachments,
      maxReplies: this.deps.config.replies.max,
      mediaUpload: this.deps.config.media.allowUpload,
    });

    this.current = {
      turnId,
      groupId: stored.groupId,
      messageId: stored.messageId,
      userId: stored.userId,
      started: false,
      replied: 0,
      createdAt: this.now(),
    };
    const pendingTurnId = turnId;
    this.current.timer = setTimeout(() => {
      void this.onTimeout(pendingTurnId);
    }, this.deps.config.replyTimeoutMs);
    this.current.timer.unref?.();

    this.deps.sendUserMessage(prompt, bundle.attachments, this.deps.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  markRunStarted(prompt: string): void {
    if (this.current && !this.current.started && prompt.includes(`turn:${this.current.turnId}`)) {
      this.current.started = true;
    }
  }

  async reply(text: string): Promise<SendResult> {
    const turn = this.current;
    if (!turn) return { sent: false, count: 0, reason: "no-turn" };
    if (this.limitReached(turn)) return { sent: false, count: turn.replied, reason: "limit" };
    const data = await this.deps.client.call<{ message_id?: number | string }>("send_group_msg", {
      group_id: Number(turn.groupId),
      message: [
        { type: "reply", data: { id: Number(turn.messageId) } },
        { type: "text", data: { text } },
      ],
    });
    if (data?.message_id !== undefined && data?.message_id !== null) this.sentIds.add(String(data.message_id));
    turn.replied += 1;
    return { sent: true, count: turn.replied };
  }

  async sendMedia(input: MediaInput): Promise<SendResult> {
    const turn = this.current;
    if (!turn) return { sent: false, count: 0, reason: "no-turn" };
    if (!this.deps.config.media.allowUpload) return { sent: false, count: turn.replied, reason: "disabled" };
    if (this.limitReached(turn)) return { sent: false, count: turn.replied, reason: "limit" };
    if (!input.path || !existsSync(input.path)) return { sent: false, count: turn.replied, reason: "missing" };
    const size = statSync(input.path).size;
    if (size > this.deps.config.media.maxFileBytes) return { sent: false, count: turn.replied, reason: "too-large" };

    try {
      if (input.kind === "image") {
        const base64 = readFileSync(input.path).toString("base64");
        const data = await this.deps.client.call<{ message_id?: number | string }>("send_group_msg", {
          group_id: Number(turn.groupId),
          message: [{ type: "image", data: { file: `base64://${base64}` } }],
        });
        if (data?.message_id !== undefined && data?.message_id !== null) this.sentIds.add(String(data.message_id));
      } else {
        await this.deps.client.call("upload_group_file", {
          group_id: Number(turn.groupId),
          file: input.path,
          name: input.name ?? basename(input.path),
        });
      }
    } catch (error) {
      this.deps.log?.(`发送媒体失败：${(error as Error).message}`);
      return { sent: false, count: turn.replied, reason: "send-failed" };
    }

    turn.replied += 1;
    return { sent: true, count: turn.replied };
  }

  private limitReached(turn: TurnState): boolean {
    const max = this.deps.config.replies.max;
    if (max < 0) return false;
    return turn.replied >= max;
  }

  async settle(outcome: SettleOutcome): Promise<void> {
    const turn = this.current;
    if (!turn) return;
    const failed = outcome.aborted || Boolean(outcome.error);

    if (failed) {
      await this.react(turn.messageId, this.deps.config.reactions.fail);
      if (turn.replied === 0) {
        await this.sendText(turn.groupId, outcome.error ? `pi 执行失败：${outcome.error}` : "pi 的执行被中断了。");
      }
    } else {
      if (turn.replied === 0) {
        const fallback = (outcome.lastText ?? "").trim();
        if (fallback) await this.reply(fallback);
        else await this.sendText(turn.groupId, "pi 没有给出答复。");
      }
      await this.react(turn.messageId, this.deps.config.reactions.done);
    }

    this.clear();
  }

  private clear(): void {
    if (this.current?.timer) clearTimeout(this.current.timer);
    this.current = null;
  }

  private async onTimeout(turnId: string): Promise<void> {
    if (!this.current || this.current.turnId !== turnId) return;
    this.deps.log?.(`turn ${turnId} 超时`);
    await this.react(this.current.messageId, this.deps.config.reactions.fail);
    await this.sendText(this.current.groupId, "pi 处理超时，请稍后再试。");
    this.clear();
  }

  private async resolveQuoted(message: StoredMessage): Promise<StoredMessage | null> {
    if (!message.replyTo) return null;
    const cached = this.deps.store.get(message.groupId, message.replyTo);
    if (cached) return cached;
    try {
      const data = await this.deps.client.call<Record<string, unknown>>("get_msg", { message_id: Number(message.replyTo) });
      const quoted = fromApiMessage(data, message.groupId);
      if (!quoted) return null;
      this.deps.store.insert(quoted);
      return quoted;
    } catch (error) {
      this.deps.log?.(`取被引用消息失败：${(error as Error).message}`);
      return null;
    }
  }

  private selfTriggerAllowed(userId: string): boolean {
    const trigger = this.deps.config.trigger;
    if (!trigger.allowSelf) return false;
    return trigger.owners.length === 0 || trigger.owners.includes(userId);
  }

  private groupAllowed(groupId: string): boolean {
    const allow = this.deps.config.groups.allow;
    return allow.length === 0 || allow.includes(groupId);
  }

  private async react(messageId: string, emojiId: string): Promise<void> {
    try {
      await this.deps.client.call("set_msg_emoji_like", { message_id: Number(messageId), emoji_id: emojiId, set: true });
    } catch (error) {
      this.deps.log?.(`表态失败(${emojiId})：${(error as Error).message}`);
    }
  }

  private async sendText(groupId: string, text: string): Promise<void> {
    try {
      const data = await this.deps.client.call<{ message_id?: number | string }>("send_group_msg", {
        group_id: Number(groupId),
        message: [{ type: "text", data: { text } }],
      });
      if (data?.message_id !== undefined && data?.message_id !== null) this.sentIds.add(String(data.message_id));
    } catch (error) {
      this.deps.log?.(`发送失败：${(error as Error).message}`);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }
}

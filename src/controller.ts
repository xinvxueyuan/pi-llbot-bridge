import { readFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { loadConfig } from "./config";
import { ReverseWsServer } from "./llbot/server";
import { MessageStore } from "./store/db";
import { Bridge, type ContextBundle, type SettleOutcome } from "./bridge/bridge";
import { collectWindow } from "./bridge/window";
import { filterTranscript } from "./bridge/filter";
import { MediaCache } from "./media/cache";
import { fetchAttachment } from "./media/fetch";
import { fromApiMessage } from "./llbot/parse";
import type { Attachment, StoredMessage } from "./types";
import type { PromptAttachment } from "./bridge/prompt";

function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export class BridgeController {
  private server: ReverseWsServer | null = null;
  private store: MessageStore | null = null;
  private cache: MediaCache | null = null;
  private instance: Bridge | null = null;
  private lastContext: ExtensionContext | null = null;
  private outcome: SettleOutcome = { aborted: false };

  constructor(private readonly pi: ExtensionAPI) {}

  get bridge(): Bridge | null {
    return this.instance;
  }

  status(): string {
    if (!this.server) return "未启动";
    if (!this.server.connected) return `等待 LLBot 连入 :${this.server.port}`;
    return `已连接 ${this.instance?.selfName ?? ""}(${this.instance?.selfId ?? ""})`;
  }

  touch(context: ExtensionContext): void {
    this.lastContext = context;
  }

  async start(context: ExtensionContext): Promise<void> {
    if (this.server) throw new Error("LLBot 桥已在运行，先执行 /link-llbot off");
    this.touch(context);

    const config = loadConfig(getAgentDir());
    if (!config.server.accessToken) {
      throw new Error(
        "缺少 accessToken：在 ~/.pi/agent/llbot-bridge/config.json 的 server.accessToken 填值，或设 PI_LLBOT_ACCESS_TOKEN",
      );
    }

    const store = new MessageStore(config.store.path);
    const cache = new MediaCache({
      dir: config.media.dir,
      maxFileBytes: config.media.maxFileBytes,
      ttlHours: config.media.ttlHours,
      maxTotalBytes: config.media.maxTotalBytes,
    });
    const server = new ReverseWsServer({
      host: config.server.host,
      port: config.server.port,
      path: config.server.path,
      accessToken: config.server.accessToken,
      log: (message) => context.ui.notify(message, "info"),
    });

    const history = async (args: { groupId: string; messageSeq: number; count: number }): Promise<StoredMessage[]> => {
      const data = await server.call<{ messages?: Record<string, unknown>[] }>("get_group_msg_history", {
        group_id: Number(args.groupId),
        message_seq: args.messageSeq,
        count: args.count,
      });
      return (data.messages ?? [])
        .map((raw) => fromApiMessage(raw, args.groupId))
        .filter((message): message is StoredMessage => message !== null);
    };

    const complete = async (prompt: string): Promise<string> => {
      const live = this.lastContext ?? context;
      const model = live.model;
      if (!model) throw new Error("当前会话没有可用模型");
      const reply = await live.modelRegistry.complete(model, {
        systemPrompt: "你是 QQ 群聊记录筛选器，只做删除无关行的操作，不回答提问。",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      });
      if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "筛选请求失败");
      return reply.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("\n");
    };

    const collectContext = async ({
      groupId,
      quoted,
      request,
    }: {
      groupId: string;
      quoted: StoredMessage | null;
      request: string;
    }): Promise<ContextBundle> => {
      const messages = await collectWindow({
        config: config.context,
        groupId,
        quoted,
        store,
        history,
        log: (message) => context.ui.notify(message, "warning"),
      });

      const attachments: PromptAttachment[] = [];
      if (config.media.enabled) {
        for (const message of messages) {
          if (message.attachments.length === 0) continue;
          const updated: Attachment[] = [];
          let changed = false;
          for (const attachment of message.attachments) {
            if (attachment.kind === "image" && !config.media.downloadImages) continue;
            if (attachment.kind !== "image" && !config.media.downloadFiles) continue;
            const fetched = await fetchAttachment(attachment, {
              cache,
              maxFileBytes: config.media.maxFileBytes,
              timeoutMs: config.media.downloadTimeoutMs,
              call: (action, params) => server.call(action, params),
              download: async (url) => {
                const response = await fetch(url, { signal: AbortSignal.timeout(config.media.downloadTimeoutMs) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return Buffer.from(await response.arrayBuffer());
              },
              log: (text) => context.ui.notify(text, "warning"),
            });
            updated.push(fetched);
            if (fetched.cachedPath !== attachment.cachedPath) changed = true;
            if (fetched.cachedPath) {
              attachments.push({ kind: fetched.kind, name: fetched.name, path: fetched.cachedPath, from: message.senderName });
            }
          }
          if (changed) store.insert({ ...message, attachments: updated });
        }
        cache.prune();
      }

      const transcript = await filterTranscript(messages, request, { config: config.context.filter, complete });
      return { transcript, attachments };
    };

    const bridge = new Bridge({
      config,
      store,
      client: server,
      isIdle: () => (this.lastContext ? this.lastContext.isIdle() : true),
      log: (message) => context.ui.notify(message, "warning"),
      collectContext,
      sendUserMessage: (prompt, attachments, options) => {
        const model = (this.lastContext?.model ?? context.model) as { input?: readonly string[] } | undefined;
        const supportsImages = Array.isArray(model?.input) && model.input.includes("image");
        const images = supportsImages
          ? attachments.filter((attachment) => attachment.kind === "image" && attachment.path).slice(0, config.media.attachImages)
          : [];
        if (images.length === 0) {
          this.pi.sendUserMessage(prompt, options);
          return;
        }
        const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: prompt },
        ];
        for (const image of images) {
          blocks.push({ type: "image", data: readFileSync(image.path).toString("base64"), mimeType: mimeOf(image.path) });
        }
        this.pi.sendUserMessage(blocks, options);
      },
    });

    server.onEvent((event) => {
      void bridge.handleEvent(event).catch((error: unknown) => {
        context.ui.notify(`处理群消息失败：${(error as Error).message}`, "error");
      });
    });

    server.onConnection((info) => {
      if (info.selfId) bridge.selfId = info.selfId;
      void server
        .call<{ user_id: number; nickname: string }>("get_login_info")
        .then((login) => {
          bridge.selfId = String(login.user_id);
          bridge.selfName = login.nickname || String(login.user_id);
          context.ui.setStatus("llbot", `LLBot ${bridge.selfName}(${bridge.selfId})`);
          context.ui.notify(`LLBot 已连入：${bridge.selfName}(${bridge.selfId})`, "info");
        })
        .catch((error: unknown) => {
          context.ui.notify(`取账号信息失败：${(error as Error).message}`, "error");
        });
    });

    const port = await server.listen();
    cache.prune();

    this.server = server;
    this.store = store;
    this.cache = cache;
    this.instance = bridge;
    context.ui.setStatus("llbot", `等待 LLBot 连入 :${port}`);
    context.ui.notify(`已监听 ws://${config.server.host}:${port}${config.server.path}，等待 LLBot 连入…`, "info");
  }

  stop(): void {
    void this.server?.close();
    this.store?.close();
    this.server = null;
    this.store = null;
    this.cache = null;
    this.instance = null;
  }

  recordRun(messages: AgentMessage[]): void {
    const last = [...messages].reverse().find((message) => message.role === "assistant") as
      | { content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string }
      | undefined;
    if (!last) return;
    const text = (last.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    this.outcome = {
      aborted: last.stopReason === "aborted",
      error: last.stopReason === "error" ? (last.errorMessage ?? "模型返回错误") : undefined,
      lastText: text,
    };
  }

  async settle(event: { aborted: boolean }): Promise<void> {
    const bridge = this.instance;
    if (!bridge || !bridge.turn || !bridge.turn.started) return;
    const outcome = this.outcome;
    this.outcome = { aborted: false };
    await bridge.settle({ aborted: event.aborted || outcome.aborted, error: outcome.error, lastText: outcome.lastText });
  }
}

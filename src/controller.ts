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
import { fetchAttachment, type FetchDeps } from "./media/fetch";
import { MediaPrefetcher } from "./media/prefetch";
import { fromApiMessage } from "./llbot/parse";
import { expandForward } from "./llbot/forward";
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
  private stopping: Promise<void> | null = null;

  constructor(private readonly pi: ExtensionAPI) {}

  get bridge(): Bridge | null {
    return this.instance;
  }

  status(): string {
    if (!this.server) return "未启动";
    if (!this.server.connected) return `等待 LLBot 连入 :${this.server.port}`;
    return `已连接 ${this.instance?.selfName ?? ""}(${this.instance?.selfId ?? ""})`;
  }

  async pingStatus(): Promise<string> {
    const status = this.status();
    if (!this.instance || !this.server?.connected) return status;
    const ping = await this.instance.ping();
    return ping.sent ? `${status}（已在群 ${ping.groupId} 的最新消息上打 ping 表态）` : `${status}（暂无可表态的消息）`;
  }

  touch(context: ExtensionContext): void {
    this.lastContext = context;
  }

  async autoStart(context: ExtensionContext): Promise<void> {
    // /new、/reload 会先 shutdown 再 start：等上一次关闭真正完成，否则 3001 还没释放
    if (this.stopping) await this.stopping.catch(() => undefined);
    if (this.server) return;
    const config = loadConfig(getAgentDir());
    if (!config.autoStart) return;
    if (!config.server.accessToken) {
      context.ui.setStatus("llbot", "未配置 accessToken");
      return;
    }
    await this.start(context);
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

      const forwardCache = new Map<string, string | null>();
      const expand = async (id: string): Promise<string | null> => {
        if (!forwardCache.has(id)) {
          forwardCache.set(id, await expandForward(id, { call: (a, p) => server.call(a, p), log: (t) => context.ui.notify(t, "warning") }));
        }
        return forwardCache.get(id) ?? null;
      };

      const withForwards = await Promise.all(
        messages.map(async (message) => {
          const ids = message.attachments
            .filter((attachment) => attachment.kind === "forward" && attachment.fileId)
            .map((attachment) => attachment.fileId as string);
          if (ids.length === 0) return message;
          const parts: string[] = [];
          for (const id of ids) {
            const text = await expand(id);
            if (text) parts.push(text);
          }
          return parts.length > 0 ? { ...message, text: `${message.text}\n${parts.join("\n")}`.trim() } : message;
        }),
      );

      const attachments: PromptAttachment[] = [];
      if (config.media.enabled) {
        for (const message of messages) {
          if (message.attachments.length === 0) continue;
          const updated: Attachment[] = [];
          let changed = false;
          for (const attachment of message.attachments) {
            if (attachment.kind === "forward") continue; // 合并转发走 expandForward，不下载
            if (attachment.kind === "image" && !config.media.downloadImages) continue;
            if (attachment.kind !== "image" && !config.media.downloadFiles) continue;
            const fetched = await fetchAttachment(attachment, fetchDeps);
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

      const transcript = await filterTranscript(withForwards, request, {
        config: config.context.filter,
        complete,
        log: (message) => context.ui.notify(message, "warning"),
      });
      return { transcript, attachments };
    };

    const download = async (url: string): Promise<Buffer> => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.media.downloadTimeoutMs),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) pi-llbot-bridge" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };

    const fetchDeps: FetchDeps = {
      cache,
      maxFileBytes: config.media.maxFileBytes,
      timeoutMs: config.media.downloadTimeoutMs,
      call: (action, params) => server.call(action, params),
      download,
      log: (text) => context.ui.notify(text, "warning"),
    };

    const prefetcher = new MediaPrefetcher({
      fetch: (attachment) => fetchAttachment(attachment, fetchDeps),
      save: (message, attachments) => store.insert({ ...message, attachments }),
      concurrency: 3,
      log: (text) => context.ui.notify(text, "warning"),
      shouldFetch: (attachment) =>
        attachment.kind === "image" ? config.media.downloadImages : config.media.downloadFiles,
    });

    const bridge = new Bridge({
      config,
      store,
      client: server,
      onMessage: (message) => {
        if (config.media.enabled && config.media.eagerDownload) prefetcher.enqueue(message);
      },
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

    let port: number;
    try {
      port = await server.listen();
    } catch (error) {
      store.close();
      throw error;
    }
    cache.prune();

    this.server = server;
    this.store = store;
    this.cache = cache;
    this.instance = bridge;
    context.ui.setStatus("llbot", `等待 LLBot 连入 :${port}`);
    context.ui.notify(`已监听 ws://${config.server.host}:${port}${config.server.path}，等待 LLBot 连入…`, "info");
  }

  async stop(): Promise<void> {
    const server = this.server;
    const store = this.store;
    this.server = null;
    this.store = null;
    this.cache = null;
    this.instance = null;
    if (!server && !store) return;
    this.stopping = (async () => {
      try {
        await server?.close();
      } catch {
        /* 已经关掉就算了 */
      }
      try {
        store?.close();
      } catch {
        /* ignore */
      }
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
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

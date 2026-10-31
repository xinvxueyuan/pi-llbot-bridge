import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ObEvent } from "../types";

export interface ReverseWsOptions {
  host: string;
  port: number;
  path: string;
  accessToken: string;
  log?: (message: string) => void;
}

export interface ConnectionInfo {
  selfId: string;
  remote: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReverseWsServer {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private sequence = 0;
  private actualPort = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: ObEvent) => void>();
  private readonly connectionListeners = new Set<(info: ConnectionInfo) => void>();

  constructor(private readonly options: ReverseWsOptions) {}

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  get port(): number {
    return this.actualPort;
  }

  listen(retries = 8, retryDelayMs = 300): Promise<number> {
    return this.tryListen(retries, retryDelayMs);
  }

  private async tryListen(retries: number, retryDelayMs: number): Promise<number> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.listenOnce();
      } catch (error) {
        lastError = error as Error;
        const busy = /EADDRINUSE/.test(lastError.message);
        if (!busy || attempt === retries) break;
        this.options.log?.(`端口 ${this.options.port} 仍被占用，${retryDelayMs}ms 后重试（${attempt + 1}/${retries}）`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw lastError ?? new Error("监听失败");
  }

  private listenOnce(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        path: this.options.path,
        maxPayload: 16 * 1024 * 1024,
      });
      this.wss = wss;

      wss.on("listening", () => {
        const address = wss.address();
        this.actualPort = typeof address === "object" && address ? address.port : this.options.port;
        this.options.log?.(`已监听 ws://${this.options.host}:${this.actualPort}${this.options.path}`);
        resolve(this.actualPort);
      });
      wss.on("error", (error) => {
        if (this.actualPort === 0) {
          this.wss = null;
          try {
            wss.close();
          } catch {
            /* ignore */
          }
          reject(error);
        } else {
          this.options.log?.(`WS 服务端错误：${error.message}`);
        }
      });
      wss.on("connection", (socket, request) => this.handleConnection(socket, request));
    });
  }

  onEvent(listener: (event: ObEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConnection(listener: (info: ConnectionInfo) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("LLBot 未连接"));
    const echo = `pi-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }));
    });
  }

  async close(): Promise<void> {
    for (const [echo, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("连接已关闭"));
      this.pending.delete(echo);
    }
    this.socket?.close(1000, "shutdown");
    this.socket = null;
    const wss = this.wss;
    this.wss = null;
    this.actualPort = 0;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const header = String(request.headers.authorization ?? "");
    const headerToken = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = headerToken || url.searchParams.get("access_token") || "";

    if (this.options.accessToken && token !== this.options.accessToken) {
      this.options.log?.("LLBot 连接被拒绝：access_token 不匹配");
      socket.close(1008, "unauthorized");
      return;
    }

    if (this.socket && this.socket !== socket) this.socket.close(1000, "replaced");
    this.socket = socket;

    socket.on("message", (data) => this.handleMessage(String(data)));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.options.log?.("LLBot 连接断开，等待重连");
      }
    });

    const selfId = String(request.headers["x-self-id"] ?? "");
    const info: ConnectionInfo = { selfId, remote: String(request.socket.remoteAddress ?? "") };
    this.options.log?.(`LLBot 已连入：self=${selfId || "未知"} remote=${info.remote}`);
    for (const listener of this.connectionListeners) listener(info);
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const echo = payload.echo;
    if (typeof echo === "string" && this.pending.has(echo)) {
      const waiter = this.pending.get(echo)!;
      this.pending.delete(echo);
      clearTimeout(waiter.timer);
      if (payload.status === "ok" || payload.retcode === 0) waiter.resolve(payload.data ?? null);
      else waiter.reject(new Error(`${String(payload.status ?? "failed")}: ${String(payload.message ?? payload.wording ?? payload.retcode)}`));
      return;
    }
    for (const listener of this.eventListeners) listener(payload as unknown as ObEvent);
  }
}

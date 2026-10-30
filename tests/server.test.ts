import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ReverseWsServer } from "../src/llbot/server";

const servers: ReverseWsServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function start(token = "tok") {
  const server = new ReverseWsServer({ host: "127.0.0.1", port: 0, path: "/onebot/v11/ws", accessToken: token });
  const port = await server.listen();
  servers.push(server);
  return { server, port };
}

function connect(port: number, token = "tok", selfId = "999"): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
    headers: { authorization: `Bearer ${token}`, "x-self-id": selfId },
  });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.on("open", () => resolve(client));
    client.on("error", reject);
  });
}

describe("ReverseWsServer", () => {
  it("listen 监听配置端口并返回实际端口", async () => {
    const { port } = await start();
    expect(port).toBeGreaterThan(0);
  });

  it("token 正确时触发 onConnection，并带出 X-Self-ID", async () => {
    const { server, port } = await start();
    const seen: string[] = [];
    server.onConnection((info) => seen.push(info.selfId));
    await connect(port);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["999"]);
  });

  it("token 错误时以 1008 关闭连接", async () => {
    const { port } = await start("right");
    const client = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { authorization: "Bearer wrong" } });
    clients.push(client);
    const code = await new Promise<number>((resolve) => client.on("close", (c) => resolve(c)));
    expect(code).toBe(1008);
  });

  it("call 发出 action/params/echo，按 echo 关联响应", async () => {
    const { server, port } = await start();
    const client = await connect(port);
    const sent: any[] = [];
    client.on("message", (data) => {
      const payload = JSON.parse(String(data));
      sent.push(payload);
      client.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 999 }, echo: payload.echo }));
    });
    const login = await server.call<{ user_id: number }>("get_login_info");
    expect(sent[0]).toMatchObject({ action: "get_login_info", params: {} });
    expect(login.user_id).toBe(999);
  });

  it("非响应消息分发给事件监听器", async () => {
    const { server, port } = await start();
    const client = await connect(port);
    const events: unknown[] = [];
    server.onEvent((event) => events.push(event));
    client.send(JSON.stringify({ post_type: "message", message_type: "group", message_id: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1);
  });

  it("未连接时 call 立即 reject", async () => {
    const { server } = await start();
    await expect(server.call("get_login_info")).rejects.toThrow("未连接");
  });

  it("新连接替换旧连接（旧 socket 被关闭）", async () => {
    const { port } = await start();
    const first = await connect(port);
    const closed = new Promise<number>((resolve) => first.on("close", (code) => resolve(code)));
    await connect(port);
    expect(await closed).toBe(1000);
  });
});

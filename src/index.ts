import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BridgeController } from "./controller";
import { makeReplyTool } from "./tools/reply";
import { makeMediaTool } from "./tools/media";

export default function llbotBridge(pi: ExtensionAPI) {
  const controller = new BridgeController(pi);

  pi.registerCommand("link-llbot", {
    description: "启动/查看/停止 LLBot 反向 WS 桥：/link-llbot | /link-llbot status | /link-llbot off",
    handler: async (args, ctx) => {
      controller.touch(ctx);
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "off") {
        await controller.stop();
        ctx.ui.setStatus("llbot", undefined);
        ctx.ui.notify("LLBot 桥已停止", "info");
        return;
      }
      if (sub === "status") {
        ctx.ui.notify(controller.status(), "info");
        return;
      }
      try {
        await controller.start(ctx);
      } catch (error) {
        ctx.ui.notify(`LLBot 桥启动失败：${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("lls", {
    description: "link-llbot status 的别名：查看连接状态，并在最近一条群消息上打一个 ping 表态",
    handler: async (_args, ctx) => {
      controller.touch(ctx);
      ctx.ui.notify(await controller.pingStatus(), "info");
    },
  });

  pi.registerTool(makeReplyTool(() => controller.bridge));
  pi.registerTool(makeMediaTool(() => controller.bridge));

  // 常驻模式：会话启动即自动连 LLBot（配置 autoStart=false 可关）
  pi.on("session_start", async (_event, ctx) => {
    controller.touch(ctx);
    try {
      await controller.autoStart(ctx);
    } catch (error) {
      ctx.ui.notify(`LLBot 自动连接失败：${(error as Error).message}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") controller.bridge?.markRunStarted(event.prompt);
  });
  pi.on("agent_end", (event) => controller.recordRun(event.messages));
  pi.on("agent_settled", async (event, ctx) => {
    controller.touch(ctx);
    await controller.settle({ aborted: event.aborted });
  });
  pi.on("session_shutdown", async () => {
    await controller.stop();
  });
}

# pi-llbot-bridge

把本机 LLBot（OneBot 11，**反向 WebSocket**）的 QQ 群聊桥进当前 pi 会话的 pi 扩展。

## 安装与配置

```bash
pi install npm:pi-llbot-bridge     # 从 npm 安装（也可以 pi install ./ 装本地源码）
mkdir -p ~/.pi/agent/llbot-bridge
cp config.example.json ~/.pi/agent/llbot-bridge/config.json
```

开发期直接跑源码：`pi -e ./src/index.ts`。

配置写在 `~/.pi/agent/llbot-bridge/config.json`（模板见 `config.example.json`）。环境变量可覆盖：

| env | 含义 |
|---|---|
| `PI_LLBOT_HOST` / `PI_LLBOT_PORT` / `PI_LLBOT_PATH` | 反向 WS 监听地址与路径 |
| `PI_LLBOT_ACCESS_TOKEN` | 与 LLBot 侧一致的 token |
| `PI_LLBOT_RECENT` / `PI_LLBOT_QUOTED_BEFORE` / `PI_LLBOT_QUOTED_AFTER` | 上下文窗口 |
| `PI_LLBOT_FILTER` | `off` 关闭模型筛选（退回确定性裁剪） |
| `PI_LLBOT_MEDIA` / `PI_LLBOT_MEDIA_DIR` / `PI_LLBOT_MEDIA_TTL_HOURS` / `PI_LLBOT_ATTACH_IMAGES` | 媒体缓存 |

## LLBot 侧

在 LLBot 的 OneBot 11 配置里加一条 `ws-reverse`：

```json
{
  "type": "ws-reverse",
  "enable": true,
  "url": "ws://127.0.0.1:3001/onebot/v11/ws",
  "heartInterval": 60000,
  "token": "<与 server.accessToken 一致>",
  "reportSelfMessage": true,
  "reportOfflineMessage": false,
  "messageFormat": "array",
  "debug": false
}
```

LLBot 断线每 3 秒重连一次，所以桥和 LLBot 谁先启动都行。

## 用法

- `/link-llbot`：启动监听（状态栏显示「等待 LLBot 连入」→ 连上后显示账号）
- `/link-llbot status`：查看状态
- `/link-llbot off`：停止
- 群里：`@机器人 /pi <请求>`

## 一次请求发生了什么

1. 收到 `@机器人 /pi ...` 立刻给该消息打 38 表态；
2. 组上下文：最近 `context.recent` 条 → 若引用消息更早，以它为中心前后补采 `quotedBefore/quotedAfter` 条并按 `message_id` 去重；
3. 图片/群文件/表情包等渲染成紧凑占位，媒体下载进本地缓存；
4. 用**当前会话模型**发一次**不写主会话**的筛选请求剥噪声（失败则确定性裁剪）；
5. 把「筛选后的上下文 + 本地附件路径 + 请求」注入会话；
6. pi 调 `qq_reply` 引用回复到群里，表态变 148；异常/超时表态 10060。

## 触发方式

`trigger.requireMention` 控制是否必须 @ 机器人（**默认 `false`**：消息以命令词开头就触发）：

```json
"trigger": { "requireMention": false, "allowSelf": true, "owners": ["1330509996"] }
```

- `requireMention: false`（默认）：`/pi 你好` 就能触发，不要求 @。
- `requireMention: true`：必须 `@机器人 /pi 你好`。
- 命令词由 `command` 决定（默认 `/pi`），且要求 `^/pi(\s|$)`，`/pizza` 不会误命中。

## 主人号自己发命令（自我触发）

默认桥只处理**别人**发来的消息；如果 bot 号就是你的主号、你要自己 @ 自己下命令，需要三件事：

1. LLBot 的 `ws-reverse` 条目设 `reportSelfMessage: true`（否则 LLBot 不把自我消息上报）；
2. 桥配置加：
   ```json
   "trigger": { "allowSelf": true, "owners": ["1330509996"] }
   ```
   （或 env：`PI_LLBOT_ALLOW_SELF=on`、`PI_LLBOT_OWNERS=1330509996`）
3. `owners` 为空数组时只受 `allowSelf` 控制；**建议始终写死主人号**。

防自激：桥会记住自己发出消息的 `message_id`，同一 id 不会再触发；且触发必须有 `@自己 + /pi` 前缀，普通答复不会命中。

## 媒体缓存

- 目录：`media.dir`，默认 `~/.pi/agent/llbot-bridge/cache`；sha256 内容寻址，同内容复用。
- `ttlHours` 过期删除（`0` = 不按时间过期），`maxTotalBytes` 超限按最旧删除，`maxFileBytes` 单文件上限。
- `attachImages` 控制随消息附带几张图（0 = 只给路径）；模型不支持图片输入时会自动跳过附带，只留路径。

## 限制

- 不修改会话模型/思考等级（含筛选请求）。
- 单飞：同一时刻只处理一条 QQ 请求，忙碌时回提示。
- 只在群聊生效；私聊不处理。
- 不转码、不 OCR；文件内容由 pi 自己按路径读取。

## License

MIT © 2026 新v学员 (xinvxueyuan)

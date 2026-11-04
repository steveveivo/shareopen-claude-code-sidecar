# ShareOpen × Claude Code 连接器（P2，本地 sidecar）

> 状态：P2（2026-09-29）。本地 CLI agent。协议见 `sdk/PROTOCOL.md`。

Claude Code 跑在**用户机器上**，ShareOpen 云端触不到它——所以 P2 不是
后端云 relay，而是**本地 WS sidecar**：

```
ShareOpen  ←—WS—→  sidecar（用户机器）  ←—headless—→  claude -p
```

- **入站（用户 → claude）**：用户消息经 WS 到 sidecar，sidecar spawn
  `claude -p <prompt> --output-format json`，把结果流式推回 ShareOpen 会话。
- **出站（claude → 用户）**：Claude Code 的 hook（`Stop`/`PostToolUse`/
  `Notification`）把事件喂给 sidecar，sidecar 作为 progress / 最终答案
  推进 ShareOpen。

## 用法

### 1) 纯 headless（默认，无需配 hook）
```bash
# 1. 生成/取 agent token
curl -X POST https://shareopen.com/api/agents/<id>/regenerate-token \
  -H "Authorization: Bearer <user_token>"
# 2. 启动 sidecar
node connectors/claude-code/index.js serve \
  --agent-id <id> --token <so_live_...> --shareopen https://shareopen.com
```

### 2) hook 补充（工具进度）
Claude Code `settings.json`（`/hooks` 命令或直接编辑）：
```json
{ "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node <path>/index.js hook --agent-id <id> --token <so> --event Stop"
    }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{
      "type": "command",
      "command": "node <path>/index.js hook --agent-id <id> --token <so> --event PostToolUse"
    }] }]
} }
```
hook 的 JSON 走 stdin 进 sidecar，sidecar 推 `agent_message` 到 ShareOpen。

## 边界 / 已知限制
- `claude -p` 输出 JSON：`{ result, total_cost_usd, ... }`；超时 5min 强杀。
- hook 输出 10k 字符上限（Claude Code 限制）——长回复靠 sidecar 的
  `stream` 分片 + outbox 补发（spec §5.6），不靠 hook 本身。
- sidecar 断连期间用户消息由后端 agentMessageQueue 补发（`/ws/agent`
  既有机制），sidecar 重连后自动收到。
- 内部 agent 链路零改动：本 connector 纯本地代码 + 复用现有 `/ws/agent`。

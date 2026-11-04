#!/usr/bin/env node
/**
 * ShareOpen x Claude Code — local WS sidecar (P2).
 *
 * Claude Code is a LOCAL CLI agent: the ShareOpen cloud can't reach it.
 * The sidecar runs on the user's machine and bridges:
 *
 *   ShareOpen  <—WS—>  sidecar  <—headless—>  `claude -p`
 *
 * Inbound (user → ShareOpen → claude):
 *   User message arrives on the WS as `text_message`/`agent_message`.
 *   The sidecar spawns `claude -p <prompt> --output-format json` (or streams
 *   with `--output-format stream-json`) and pushes the result back to the
 *   ShareOpen conversation via `agent_message` frames.
 *
 * Outbound (claude → ShareOpen → user):
 *   Claude Code hooks (Stop / PostToolUse / Notification) feed events into
 *   the sidecar via a local unix socket or a CLI flag; the sidecar pushes
 *   tool-use progress + the final answer into ShareOpen.
 *
 * Two usage patterns:
 *
 *   A) Pure headless (default, no hooks needed):
 *        node index.js serve --agent-id <id> --token <so_token> --shareopen <url>
 *      The sidecar is the ONLY path. User messages come in via WS, sidecar
 *      runs `claude -p`, streams back. Claude Code hooks are NOT required.
 *
 *   B) Hook-supplemented (rich progress):
 *      Configure Claude Code hooks to call:
 *        node index.js hook --event <event> --agent-id <id> [--stdin]
 *      The hook passes tool_use / stop / notification JSON to the sidecar,
 *      which forwards it into ShareOpen as stream/typing frames.
 *
 * Install / configure:
 *   1. Generate an agent token (or use an existing one):
 *        POST /api/agents/:id/regenerate-token
 *   2. node index.js serve --agent-id <id> --token <so_live_...> \
 *        --shareopen https://shareopen.com
 *   3. (optional) Wire Claude Code hooks to push progress (see README).
 */

import { ShareOpenConnector } from './sdk/index.js'
import { handleCommand, registerBuiltins } from './builtin-commands.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cmd = process.argv[2]
const args = parseArgs(process.argv.slice(3))

const agentId = args['agent-id'] || process.env.CC_AGENT_ID || ''
const soToken = args.token || process.env.SO_AGENT_TOKEN || ''
const shareopen = args.shareopen || process.env.SHAREOPEN_URL || 'http://localhost:3021'
const workdir = args['workdir'] || process.cwd()
const claudeBin = args['claude-bin'] || process.env.CC_BIN || 'claude'
const claudeModel = args['claude-model'] || process.env.CC_MODEL || ''

// ── serve mode: WS sidecar ─────────────────────────────────────────────

async function serve() {
  // Token alone identifies the agent (the backend resolves it via
  // /ws/agent?token=…); --agent-id is an optional log label only.
  if (!soToken) {
    fail('serve requires --token (or SO_AGENT_TOKEN env; token identifies the agent)')
  }

  const sdk = new ShareOpenConnector({
    transport: 'ws',
    host: shareopen,
    token: soToken,
    autoReconnect: true,
  })

  await sdk.connect()
  console.log(`[claude-sidecar] WS connected → ${shareopen} (agent ${agentId})`)

  const { execFile } = await import('node:child_process')
  const { rm, cp } = await import('node:fs/promises')

  // / command menu: register built-in slash commands + handle invocations.
  registerBuiltins(sdk, {
    agentName: 'Claude Code',
    binLabel: 'Claude Code CLI',
    workdir,
    describeSelf: async () => {
      try {
        const { execFile } = await import('node:child_process')
        const v = await new Promise((res) => execFile(claudeBin, ['--version'], (e, so) => res(so || '')))
        const model = claudeModel || 'default'
        return `claude ${String(v).trim().split('\n')[0]} · model ${model}`
      } catch { return '未知' }
    },
  })
  sdk.on('command', (inv) => handleCommand(inv, sdk, {
    agentName: 'Claude Code', binLabel: 'Claude Code CLI', workdir,
  }))

  sdk.on('message', async (msg) => {
    const { conversation_id: convId, text } = msg
    const media = msg.media || null
    const group = msg.group || null   // [P0 2026-11-03] 群信封块
    if (!convId) return
    if (!text && !media) return
    console.log(`[claude-sidecar] user msg in ${convId}: ${(text || '').slice(0, 60)}${media ? ' +media' : ''}…`)

    // Stage media attachments in the project dir so Claude Code's Read tool
    // can access them (it can't fetch remote URLs).
    let mediaDir = null
    let localAttachments = []
    if (media) {
      const staged = await stageAttachments(media, workdir)
      localAttachments = staged.paths
      mediaDir = staged.dir
    }

    const prompt = buildPrompt(text, localAttachments, group)
    await sdk.typing(convId, true)
    const result = await runClaudeHeadless(prompt, workdir)
    await sdk.typing(convId, false)

    // Best-effort cleanup of staged media after the turn.
    if (mediaDir) {
      try { await rm(mediaDir, { recursive: true, force: true }) } catch {}
    }

    if (result.error) {
      await sdk.send(convId, `[claude-code error] ${result.error}`)
    } else {
      // Stream chunks if available, otherwise send the final answer.
      if (result.chunks) {
        await sdk.stream(convId, result.chunks)
      } else {
        await sdk.send(convId, result.text || '(no output)')
      }
    }
  })

  sdk.on('close', (code) => {
    console.warn(`[claude-sidecar] WS closed (${code}); auto-reconnect in 5s`)
  })

  // Keep process alive.
  process.on('SIGINT', async () => {
    console.log('\n[claude-sidecar] shutting down…')
    await sdk.disconnect()
    process.exit(0)
  })
}

/**
 * Run `claude -p <prompt>` headlessly and capture the JSON output.
 * Returns { text, chunks?, error? }.
 */
function runClaudeHeadless(prompt, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(claudeBin, [
      '-p', prompt,
      '--output-format', 'json',
      ...(claudeModel ? ['--model', claudeModel] : []),
    ], {
      cwd,
      env: process.env,
      // [fix 2026-10-01] stdin 'ignore': claude -p with a piped prompt warns
      // "no stdin data received in 3s" and intermittently exits non-zero
      // (surfaced as [claude-code error] bubbles). Same class of bug the
      // codex sidecar fixed in 036da54 — claude missed it.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ error: stderr.slice(0, 500) || `claude exited ${code}` })
      }
      try {
        const parsed = JSON.parse(stdout)
        // Claude Code JSON output: { result, total_cost_usd, ... }
        resolve({ text: parsed.result || stdout })
      } catch {
        resolve({ text: stdout })
      }
    })

    proc.on('error', (e) => resolve({ error: e.message }))
    setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        resolve({ error: 'claude timed out after 5min' })
      }
    }, 5 * 60 * 1000)
  })
}

/**
 * Build the prompt for `claude -p`, folding in local attachment paths so the
 * model can Read them with its built-in tools.  If no text is present, emit a
 * short instruction so the model knows to look at the files.
 */
function buildPrompt(text, localAttachments, group = null) {
  const parts = []
  // [P0 2026-11-03] 群上下文: 置顶渲染"我是谁(角色) / 群成员 / 最近发言 / 谁@了我".
  // 单聊 group=null → 零成本.
  if (group && group.members && group.members.length) {
    const roleLine = group.self_role ? `\n[你在本群的角色: ${group.self_role}]` : ''
    const members = group.members
      .filter(m => m && m.name)
      .map(m => `- ${m.name} (${m.type === 'agent' ? 'agent' : 'human'}${m.role ? `, 角色: ${m.role}` : ''})`)
      .join('\n')
    const recent = (group.recent || [])
      .filter(r => r && r.text && r.text.trim())
      .slice(-10)
      .map(r => `[${r.type === 'agent' ? 'agent' : 'user'} ${r.from}]: ${(r.text || '').slice(0, 300)}`)
      .join('\n')
    const mentioned = (group.mentions || []).filter(m => m && m.name).map(m => m.name)
    const mentionNote = mentioned.length ? `\n[本条消息 @了你: ${mentioned.join(', ')}]` : ''
    parts.push(
      `[Group context — 你在一个 ShareOpen 群聊里]${roleLine}\n` +
      `群成员:\n${members}\n` +
      (recent ? `最近发言:\n${recent}\n` : '') +
      mentionNote
    )
  }
  if (text) parts.push(text)
  if (localAttachments.length) {
    const lines = localAttachments.map(a =>
      `- ${a.path} (source name: ${a.name}${a.type ? `, type: ${a.type}` : ''})`
    )
    parts.push(
      `\n[Attached files — read them with the Read tool before answering]\n${lines.join('\n')}`
    )
    if (!text) parts.push('Please analyze the attached file(s).')
  }
  return parts.join('\n')
}

/**
 * Download media attachments into a per-message local staging dir inside the
 * Claude Code project directory.  Claude Code can't fetch remote URLs —
 * it reads local files via its built-in Read tool.  Files land in
 * `.so-media/<uuid>/` so Claude's default project-roots scope includes them;
 * the caller cleans the dir up after `claude -p` exits.
 *
 * @param {Array<{url?: string, media_url?: string, file_name?: string, type?: string, media_type?: string}>} media
 * @returns {Promise<{paths: Array<{path: string, name: string, type: string}>, dir: string}>}
 */
async function stageAttachments(media, workdir) {
  const dir = join(workdir, '.so-media', randomUUID().slice(0, 12))
  mkdirSync(dir, { recursive: true })
  const out = []
  const items = Array.isArray(media) ? media : [media]
  for (const att of items) {
    const url = att?.url || att?.media_url
    if (!url) continue
    const fname = (att.file_name || url.split('/').pop() || 'attachment').replace(/[^\w.\-]/g, '_')
    const localPath = join(dir, fname)
    try {
      const res = await fetch(url)
      if (!res.ok) {
        console.warn(`[claude-sidecar] media download ${res.status}: ${url.slice(0, 80)}`)
        continue
      }
      writeFileSync(localPath, Buffer.from(await res.arrayBuffer()))
      out.push({ path: localPath, name: fname, type: att.type || att.media_type || '' })
      console.log(`[claude-sidecar] media staged: ${localPath}`)
    } catch (e) {
      console.warn(`[claude-sidecar] media download failed: ${e.message}`)
    }
  }
  return { paths: out, dir }
}

// ── hook mode: receive a Claude Code hook event ────────────────────────

async function hook() {
  if (!agentId || !soToken) {
    fail('hook requires --agent-id and --token')
  }
  const event = args.event || process.env.CC_HOOK_EVENT || 'Stop'

  // Read JSON from stdin (Claude Code passes it there).
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let payload
  try { payload = JSON.parse(raw || '{}') } catch { payload = { raw } }

  const sdk = new ShareOpenConnector({ transport: 'ws', host: shareopen, token: soToken, autoReconnect: false })
  await sdk.connect()

  const convId = payload.conversation_id || process.env.SHAREOPEN_CONVERSATION_ID || agentId
  const content = describeHookEvent(event, payload)

  if (content) {
    await sdk.send(convId, content, { messageId: `msg_cc_hook_${randomUUID().slice(0, 8)}` })
  }
  await sdk.disconnect()
  process.exit(0)
}

function describeHookEvent(event, p) {
  switch (event) {
    case 'Stop':
      return p.last_assistant_message || p.message
        ? `[claude-code] turn complete: ${(p.last_assistant_message || p.message).slice(0, 500)}`
        : null
    case 'PostToolUse':
      return p.tool_name
        ? `[claude-code] tool ${p.tool_name} completed`
        : null
    case 'Notification':
      return p.message ? `[claude-code] ${p.message}` : null
    default:
      return null
  }
}

// ── shared ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    }
  }
  return out
}

function fail(msg) {
  console.error(`[claude-sidecar] ${msg}`)
  process.exit(1)
}

// In hook mode the pipe is stdin — only serve mode must NOT read stdin.
const useStdin = cmd === 'hook'

switch (cmd) {
  case 'serve':
    serve().catch((e) => fail(e.message))
    break
  case 'hook':
    hook().catch((e) => fail(e.message))
    break
  default:
    console.log('Usage:')
    console.log('  node index.js serve --agent-id <id> --token <so_live_...> [--shareopen <url> --workdir <dir> --claude-bin <path>]')
    console.log('  node index.js hook  --agent-id <id> --token <so_live_...> --event <Stop|PostToolUse|Notification>  (reads stdin JSON)')
    console.log('')
    console.log('  Claude Code hook (settings.json):')
    console.log('    { "hooks": { "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <this>/index.js hook --agent-id <id> --token <tok> --event Stop" }] }] } }')
}

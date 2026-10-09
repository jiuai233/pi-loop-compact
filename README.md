# pi-loop-compact

**Automatically compact Pi's context during long-running tasks and resume the work afterwards.**

[npm](https://www.npmjs.com/package/pi-loop-compact) · [Install](#install) · [Commands](#commands) · [Configuration](#configuration) · [简体中文](README.zh-CN.md)

## Why use this extension?

A complex Pi task can involve repeated file reads, code searches and shell commands. Each tool result adds to the context. Pi 1.1.0 checks its built-in compaction threshold after a run ends or before a new prompt; a long sequence of tool calls can exhaust the context before that run finishes.

`pi-loop-compact` checks context usage between tool calls. At the threshold, it uses Pi's compaction to summarize earlier conversation, then resumes the current task. It is useful for code changes, investigations and research that require many consecutive tool calls, reducing interruptions caused by context exhaustion.

## How it works

- **Compact during the run:** check usage after each complete tool batch and compact at 85% by default, without waiting for the run to end.
- **Resume automatically:** by default, resume the task interrupted by compaction. If new input arrives during compaction, that input takes over without an extra continuation message.
- **Check before compacting:** skip automatic compaction with an explanation when there is nothing to summarize or the recent content Pi must retain already exceeds the threshold. The current task keeps running.

Compaction stays with Pi, using its cut-point rules, summary format and compaction model (for example `pi-compaction-model`).

## Install

Requires Node.js 24+ and Pi 1.1.0+.

```bash
pi install npm:pi-loop-compact
```

Run `/reload` in Pi. GitHub works too: `pi install git:github.com/jiuai233/pi-loop-compact`; use one source, not both. Automatic compaction is on by default at 85%. Disable other mid-run compaction extensions such as `pi-midrun-compact` to avoid double triggers.

## Commands

| Command | Action |
| --- | --- |
| `/loop-compact`, `/loop-compact status` | Show switch, threshold, current usage and the latest skip or failure reason |
| `/loop-compact now` | Compact now; when there is nothing to compact, only explain why without interrupting |

## Configuration

`~/.pi/agent/extensions/pi-loop-compact.json`; missing fields use the defaults:

```json
{
  "version": 1,
  "enabled": true,
  "threshold": 85,
  "resume": true
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Compact automatically. `/loop-compact now` works either way |
| `threshold` | Context usage percentage that triggers compaction, between 0 and 100 |
| `resume` | Send a continuation message after a mid-run compaction |

The file is re-read on each new session and on `/loop-compact status`. An invalid file pauses automatic compaction and reports the error.

## When compaction is skipped

Pi cuts only before user or assistant messages, keeps the most recent `keepRecentTokens` (20000 by default), and always keeps a tool batch together with the assistant message that issued it. Compaction cannot help when:

- everything since the last compaction belongs to that final block, for example a first message with hundreds of thousands of tokens; Pi reports "Nothing to compact";
- the final block (one huge message or tool batch) is above the threshold by itself, so usage stays above it after compacting.

The extension skips both, reports each cut point once, and lets the task continue. Once enough new content moves the cut point, it tries again. If the context really overflows, Pi's own overflow recovery still applies; a new session, or saving large inputs to disk for the model to read selectively, works better.

When compaction fails (for example, the compaction model request errors), the extension reports it, sends the continuation so the task proceeds uncompacted, and does not retry automatically at the same cut point.

## Development

```bash
npm install
npm run check
```

The RPC tests start the local `pi` (override with `PI_BINARY`) with a mock model and never contact real services.

Inspired by [pi-midrun-compact](https://github.com/leonfox28/pi-midrun-compact); the code is an independent implementation.

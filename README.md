# pi-loop-compact

**Compact Pi's context between tool batches of a long run, skip compactions that cannot help, and resume the task afterwards.**

[Install](#install) · [Commands](#commands) · [Configuration](#configuration) · [简体中文](README.zh-CN.md)

- **Compaction between tool batches:** Pi's own threshold compaction waits for the run to end, so a run with dozens of tool calls can fill the context first. This extension checks usage after every complete tool batch and compacts at the threshold.
- **Check before interrupting:** Pi's compaction aborts the current request first. The extension predicts Pi's cut point and skips, with an explanation, when Pi has nothing to summarize or when the tail Pi must keep is already above the threshold on its own. The task keeps running.
- **Resume afterwards:** if the task was running, a continuation message follows the compaction, unless you already sent input during it.

Compaction itself stays with Pi: the cut point, summary format and compaction model (for example `pi-compaction-model`) are unchanged.

## Install

Requires Node.js 24+ and Pi 1.1.0+.

```bash
pi install git:github.com/jiuai233/pi-loop-compact
```

Run `/reload` in Pi. Automatic compaction is on by default at 85%. Disable other mid-run compaction extensions such as `pi-midrun-compact` to avoid double triggers.

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

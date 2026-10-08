# pi-loop-compact

**在 Pi 长任务的工具循环中途压缩上下文，压不下去的情况提前跳过，压完自动续跑。**

[npm](https://www.npmjs.com/package/pi-loop-compact) · [安装](#安装) · [命令](#命令) · [配置](#配置) · [English](README.md)

- **工具批次之间压缩**：Pi 自带的阈值压缩要等一轮任务结束；一轮里连续几十次工具调用时，上下文可能先顶满。本扩展在每批工具结果收齐后检查用量，到阈值就压缩。
- **先判断再动手**：Pi 的压缩会先中断当前请求。扩展按 Pi 的切点规则预判，Pi 无内容可压、或必须原样保留的最后一块本身就超过阈值时，直接跳过并说明原因，任务不受影响。
- **压完接着干**：压缩前任务在运行，压缩后发一条续跑消息；压缩期间你已经插话，就不再重复发送。

压缩本身仍由 Pi 完成，切点、总结格式和压缩模型（如 `pi-compaction-model`）都不受影响。

## 安装

依赖 Node.js 24+、Pi 1.1.0+。

```bash
pi install npm:pi-loop-compact
```

装好后在 Pi 中运行 `/reload`。也可通过 GitHub 安装：`pi install git:github.com/jiuai233/pi-loop-compact`，两种来源选一种即可。默认开启，阈值 85%。其他中途压缩扩展（如 `pi-midrun-compact`）应停用，避免重复触发。

## 命令

| 命令 | 功能 |
| --- | --- |
| `/loop-compact`、`/loop-compact status` | 查看开关、阈值、当前用量和最近一次跳过或失败的原因 |
| `/loop-compact now` | 立即压缩一次；无内容可压时只提示、不中断 |

## 配置

`~/.pi/agent/extensions/pi-loop-compact.json`，缺省项取默认值：

```json
{
  "version": 1,
  "enabled": true,
  "threshold": 85,
  "resume": true
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否自动压缩。关闭后 `/loop-compact now` 仍可用 |
| `threshold` | 触发压缩的上下文用量百分比，0 到 100 之间 |
| `resume` | 中途压缩后是否发送续跑消息 |

配置在新会话或 `/loop-compact status` 时重新读取；格式错误会暂停自动压缩并提示。

## 什么时候会跳过

Pi 只在用户或助手消息之前切开，保留最近 `keepRecentTokens`（默认 20000）tokens，一批工具结果始终和发起它的助手消息放在一起。因此以下情况压缩帮不上忙：

- 上次压缩以来的内容全部属于最后一块，例如第一条消息就贴了几十万 tokens；Pi 会报 “Nothing to compact”。
- 最后一块（一条超大消息，或一批超大工具结果）本身就超过阈值，压完用量仍在阈值以上。

扩展遇到这两种情况会跳过，同一切点只提示一次，任务继续运行。之后有足够的新内容让切点后移，会重新尝试。真正撞到上下文上限时，Pi 自带的溢出恢复仍会接手；更好的做法是开新会话，或把大文件存到磁盘再让模型按需读取。

压缩失败（如压缩模型请求出错）时，扩展提示错误、发送续跑消息让任务不压缩继续，并且不在同一切点自动重试。

## 开发

```bash
npm install
npm run check
```

RPC 测试会启动本机的 `pi`（可用 `PI_BINARY` 指定）并接入模拟模型，不访问真实服务。

思路受 [pi-midrun-compact](https://github.com/leonfox28/pi-midrun-compact) 启发，代码独立实现。

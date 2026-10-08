# pi-loop-compact

Pi 工具循环中途压缩扩展，Node 24+、Pi 1.1+，TypeScript 源码直接加载。

- `src/index.ts`：触发、压缩后续跑、`/loop-compact` 命令。
- `src/cut.ts`：按 Pi `prepareCompaction()` 的切点规则预判能否压缩；该函数不在公开 API 内，Pi 升级后需核对规则是否变化。
- `src/batch.ts`：判断上下文是否停在一整批工具结果之后。
- `src/settings.ts`：`~/.pi/agent/extensions/pi-loop-compact.json` 读取与校验。
- `npm run check`：类型检查、单元测试，以及用本机 `pi` 和模拟模型跑的 RPC 测试（无 `pi` 时跳过）。

`ctx.compact()` 会先中断当前请求，任何触发路径都要先经 `planSessionCut()` 判断。
面向模型的文本（总结要求、续跑消息）用英文；界面提示用中文。
禁止提交凭据、真实提示或会话数据。

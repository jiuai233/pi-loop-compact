import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { endsWithToolBatch } from "./batch.ts";
import { describePlan, planSessionCut } from "./cut.ts";
import { DEFAULT_SETTINGS, readSettings, type Settings } from "./settings.ts";

const STATUS_KEY = "pi-loop-compact";
const ARGUMENTS = ["status", "now"];
// Model-facing text stays in English, like Pi's own summarization prompt.
export const SUMMARY_FOCUS = "The task was paused between tool calls; record the step in progress and the next tool call to make.";
export const CONTINUE_PROMPT = "[pi-loop-compact] Context was compacted mid-task. Continue the interrupted task from where it stopped.";

type Phase = "idle" | "compacting" | "resuming";

export default function loopCompact(pi: ExtensionAPI): void {
  const settingsFile = join(getAgentDir(), "extensions", "pi-loop-compact.json");
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let settingsError: string | undefined;
  let phase: Phase = "idle";
  // Bumped on every compaction and session change so stale callbacks drop out.
  let generation = 0;
  // Cut points already reported as skipped or failed, so each is announced and retried at most once.
  const handledCuts = new Set<string>();
  let lastNote: string | undefined;

  function loadSettings(ctx: ExtensionContext): void {
    try {
      settings = readSettings(settingsFile);
      settingsError = undefined;
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS, enabled: false };
      settingsError = (error as Error).message;
      ctx.ui.notify(`${settingsError}，已暂停自动压缩`, "error");
    }
  }
  function sessionId(ctx: ExtensionContext): string | undefined {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  }
  function reset(): void {
    generation++;
    phase = "idle";
    handledCuts.clear();
    lastNote = undefined;
  }
  function note(ctx: ExtensionContext, key: string, message: string, type: "warning" | "error"): void {
    lastNote = message;
    if (handledCuts.has(key)) return;
    handledCuts.add(key);
    ctx.ui.notify(`loop-compact：${message}`, type);
  }

  /** Start Pi's compaction. ctx.compact() aborts the active run first, so callers check the plan beforehand. */
  function compact(ctx: ExtensionContext, cutKey: string | undefined, resume: boolean): void {
    const session = sessionId(ctx);
    const current = ++generation;
    const stale = () => current !== generation || sessionId(ctx) !== session;
    phase = "compacting";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "压缩中"));

    async function finish(error?: Error, signal?: AbortSignal): Promise<void> {
      if (stale() || phase !== "compacting") return;
      if (error) {
        // Another automatic attempt at the same cut point would fail the same way.
        if (cutKey) handledCuts.add(cutKey);
        lastNote = `压缩失败：${error.message}`;
        ctx.ui.notify(`loop-compact：${lastNote}${resume && settings.resume ? "，任务不压缩继续" : ""}`, "error");
      }
      if (!resume || !settings.resume) {
        phase = "idle";
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      // Input queued during compaction is flushed when compaction ends; wait a tick so isIdle() sees it.
      phase = "resuming";
      await new Promise<void>((done) => setImmediate(done));
      if (stale() || phase !== "resuming") return;
      phase = "idle";
      ctx.ui.setStatus(STATUS_KEY, undefined);
      if (signal?.aborted || !ctx.isIdle()) return;
      pi.sendUserMessage(CONTINUE_PROMPT);
    }

    try {
      ctx.compact({
        customInstructions: SUMMARY_FOCUS,
        // Pi 1.1 does not await this; hosts that do keep the session alive until the continuation is sent.
        onComplete: (_result, signal?: AbortSignal) => finish(undefined, signal),
        onError: (error) => void finish(error),
      });
    } catch (error) {
      void finish(error as Error);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    loadSettings(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("context", (event, ctx) => {
    if (!settings.enabled || phase !== "idle" || !ctx.model || !endsWithToolBatch(event.messages)) return;
    const usage = ctx.getContextUsage();
    // Only a known usage at or above the threshold triggers; null, NaN or missing usage never does.
    if (!usage || usage.tokens === null || !(usage.percent !== null && usage.percent >= settings.threshold)) return;

    const session = sessionId(ctx);
    const plan = planSessionCut(ctx, (usage.contextWindow * settings.threshold) / 100);
    const cutKey = plan && plan.kind !== "compacted" ? `${session}:${plan.cutId}` : undefined;
    if (plan && plan.kind !== "ok") {
      note(ctx, `${session}:${plan.kind}:${cutKey ?? ""}`, `跳过自动压缩，${describePlan(plan, settings.threshold)}。任务继续；如果上下文溢出，开新会话或缩小输入`, "warning");
      return;
    }
    if (cutKey && handledCuts.has(cutKey)) return;

    ctx.ui.notify(`loop-compact：上下文 ${usage.percent.toFixed(1)}%（阈值 ${settings.threshold}%），开始压缩`, "info");
    compact(ctx, cutKey, true);
  });

  pi.registerCommand("loop-compact", {
    description: "查看工具循环压缩状态，或立即压缩一次（status | now）",
    getArgumentCompletions: (prefix) => {
      const choices = ARGUMENTS.filter((value) => value.startsWith(prefix));
      return choices.length ? choices.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase() || "status";
      if (argument === "status") {
        loadSettings(ctx);
        const usage = ctx.getContextUsage();
        const percent = usage?.percent === null || usage?.percent === undefined ? "未知" : `${usage.percent.toFixed(1)}%`;
        ctx.ui.notify([
          `自动压缩：${settings.enabled ? "开" : "关"} · 阈值 ${settings.threshold}% · 压缩后续跑：${settings.resume ? "开" : "关"}`,
          `当前用量：${percent} · 状态：${phase}`,
          ...(settingsError ? [`配置错误：${settingsError}`] : []),
          ...(lastNote ? [`最近提示：${lastNote}`] : []),
          `配置文件：${settingsFile}`,
        ].join("\n"), settingsError ? "error" : "info");
        return;
      }
      if (argument !== "now") {
        ctx.ui.notify("用法：/loop-compact status | now", "warning");
        return;
      }
      if (phase !== "idle") {
        ctx.ui.notify("loop-compact：已有压缩或续跑在进行", "warning");
        return;
      }
      // An explicit request may compact even if usage stays high, but never aborts the run for nothing.
      const plan = planSessionCut(ctx);
      if (plan && (plan.kind === "compacted" || plan.kind === "empty")) {
        ctx.ui.notify(`loop-compact：没有压缩，${describePlan(plan)}`, "warning");
        return;
      }
      // Resume only a run that the compaction interrupts.
      compact(ctx, undefined, !ctx.isIdle());
    },
  });
}

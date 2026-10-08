import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  getAgentDir,
  SettingsManager,
  type ExtensionContext,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

export type CutPlan =
  /** Pi refuses: the branch already ends at a compaction. */
  | { kind: "compacted" }
  /** Pi refuses: everything since the last compaction belongs to the tail it keeps. */
  | { kind: "empty"; keptTokens: number; cutId: string }
  /** Pi would compact, but the tail it keeps reaches the threshold on its own. */
  | { kind: "futile"; keptTokens: number; cutId: string }
  | { kind: "ok"; keptTokens: number; cutId: string };

// Pi cuts only before these roles, so a tool result always stays with the call that produced it.
const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

const tokensOf = (entry: ProjectedSessionEntry) =>
  entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

/**
 * Predict where Pi's compaction cuts, following the rule of Pi's internal prepareCompaction():
 * walk back from the newest entry until keepRecentTokens is reached, then keep from the
 * nearest cut point at or after that entry. Only what lies between the previous compaction
 * and the cut point gets summarized.
 */
export function planCut(
  entries: readonly ProjectedSessionEntry[],
  lastEntryType: string | undefined,
  keepRecentTokens: number,
  thresholdTokens = Number.POSITIVE_INFINITY,
): CutPlan {
  if (lastEntryType === "compaction") return { kind: "compacted" };

  const start = entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0) + 1;
  const cutPoints = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => index >= start && entry.sourceEntry.type !== "compaction" &&
      entry.messages.some((message) => CUT_ROLES.has(message.role)))
    .map(({ index }) => index);

  let cut = cutPoints[0] ?? start;
  for (let index = entries.length - 1, kept = 0; index >= start; index--) {
    kept += tokensOf(entries[index]);
    if (kept >= keepRecentTokens) {
      cut = cutPoints.find((point) => point >= index) ?? cutPoints.at(-1) ?? start;
      break;
    }
  }

  const keptTokens = entries.slice(cut).reduce((sum, entry) => sum + tokensOf(entry), 0);
  const cutId = entries[cut]?.sourceEntry.id ?? "end";
  // System messages are prompt state; Pi does not summarize them.
  const summarizable = entries.slice(start, cut).some((entry) => entry.sourceEntry.type !== "compaction" &&
    entry.messages.some((message) => message.role !== "system"));
  if (!summarizable) return { kind: "empty", keptTokens, cutId };
  return { kind: keptTokens >= thresholdTokens ? "futile" : "ok", keptTokens, cutId };
}

/** Plan a cut for the active branch; undefined when the session cannot be inspected. */
export function planSessionCut(ctx: ExtensionContext, thresholdTokens?: number): CutPlan | undefined {
  try {
    let keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
    try {
      keepRecentTokens = SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionKeepRecentTokens(ctx.model);
    } catch {
      // Unreadable Pi settings: Pi itself falls back to the same default.
    }
    const entries = ctx.sessionManager.buildSessionProjection().entries;
    return planCut(entries, ctx.sessionManager.getBranch().at(-1)?.type, keepRecentTokens, thresholdTokens);
  } catch {
    return undefined;
  }
}

/** Explain a refused or futile plan to the user. */
export function describePlan(plan: Exclude<CutPlan, { kind: "ok" }>, threshold?: number): string {
  if (plan.kind === "compacted") return "会话末尾已经是一次压缩，没有新内容可压";
  const kept = `最新一条消息或一批工具结果约 ${Math.round(plan.keptTokens).toLocaleString()} tokens，Pi 不会拆开它`;
  if (plan.kind === "empty") return `${kept}，而它就是上次压缩以来的全部内容，没有可总结的部分`;
  return `${kept}，光它就超过了 ${threshold ?? "?"}% 阈值，压缩后也降不下来`;
}

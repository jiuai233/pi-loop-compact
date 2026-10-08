import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { planCut } from "../src/cut.ts";

// Pi estimates ceil(chars / 4) tokens, so four characters make one token.
const text = (tokens: number) => "x".repeat(tokens * 4);
let id = 0;
const entry = (type: string, ...messages: unknown[]) =>
  ({ sourceEntry: { type, id: `e${++id}` }, messages }) as unknown as ProjectedSessionEntry;
const system = (tokens: number) => entry("message", { role: "system", content: text(tokens) });
const user = (tokens: number) => entry("message", { role: "user", content: text(tokens) });
const call = (tokens: number) => entry("message", { role: "assistant", content: [{ type: "text", text: text(tokens) }] });
const result = (tokens: number) => entry("message", { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: text(tokens) }] });
const compaction = (tokens: number) => entry("compaction", { role: "compactionSummary", summary: text(tokens) });

const KEEP = 20_000;
const THRESHOLD = 450_000; // 90% of a 500k window

test("an oversized first message leaves nothing to summarize", () => {
  // The session that broke the original plugin: system prompt, one huge paste, small tool loops.
  const plan = planCut([system(9_000), user(440_000), call(200), result(2_000), call(200), result(2_000)], "message", KEEP, THRESHOLD);
  assert.equal(plan.kind, "empty");
  assert.ok(plan.kind === "empty" && plan.keptTokens >= 440_000);
});

test("300k of history plus a 200k message compacts down to the message", () => {
  const history = Array.from({ length: 30 }, () => [user(500), call(500), result(9_000)]).flat();
  const plan = planCut([...history, user(200_000), call(300), result(2_000)], "message", KEEP, THRESHOLD);
  assert.equal(plan.kind, "ok");
  assert.ok(plan.kind === "ok" && plan.keptTokens < 210_000);
});

test("compacting is futile when the kept tail alone reaches the threshold", () => {
  assert.equal(planCut([user(1_000), call(5_000), result(30_000), user(455_000), call(200)], "message", KEEP, THRESHOLD).kind, "futile");
  // Tool results cannot be cut away from their call, so a huge batch is kept whole.
  const batch = planCut([user(50_000), call(100), result(200_000), result(260_000)], "message", KEEP, THRESHOLD);
  assert.equal(batch.kind, "futile");
  assert.ok(batch.kind === "futile" && batch.keptTokens >= 460_000);
  assert.equal(planCut([user(1_000), user(455_000)], "message", KEEP).kind, "ok", "no threshold means only refusals count");
});

test("only content after the previous compaction is summarized", () => {
  assert.equal(planCut([user(10_000), compaction(2_000)], "compaction", KEEP, THRESHOLD).kind, "compacted");
  // After an ineffective compaction the kept tail starts at the huge message again.
  assert.equal(planCut([compaction(3_000), user(440_000), call(200), result(3_000)], "message", KEEP, THRESHOLD).kind, "empty");
});

test("the cut point moves only once enough new content follows it", () => {
  const base = [user(440_000), call(200), result(2_000)];
  const first = planCut(base, "message", KEEP, THRESHOLD);
  const grown = [...base, call(200), result(2_000)];
  const second = planCut(grown, "message", KEEP, THRESHOLD);
  assert.ok(first.kind === "empty" && second.kind === "empty");
  assert.equal(first.cutId, second.cutId);

  const moved = planCut([...grown, user(10_000), call(200), result(15_000)], "message", KEEP, THRESHOLD);
  assert.equal(moved.kind, "ok");
  assert.ok(moved.kind === "ok" && moved.cutId !== first.cutId);
});

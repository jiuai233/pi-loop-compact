import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompactOptions, ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import loopCompact, { CONTINUE_PROMPT } from "../src/index.ts";

const text = (tokens: number) => "x".repeat(tokens * 4);
const entry = (id: string, role: string, tokens: number) => ({
  sourceEntry: { type: "message", id },
  messages: [role === "user" || role === "system"
    ? { role, content: text(tokens) }
    : { role, toolCallId: "c", content: [{ type: "text", text: text(tokens) }] }],
});
// Earlier work can be summarized away, leaving a small recent tail.
const compactable = () => [entry("old", "user", 150_000), entry("recent", "user", 25_000), entry("result", "toolResult", 1_000)];
// The session that broke the original plugin: one paste that is everything there is.
const oversizedFirst = () => [entry("system", "system", 5_000), entry("paste", "user", 240_000), entry("result", "toolResult", 1_000)];
// Summarizable history, but the paste Pi must keep is above 85% of 272k by itself.
const futile = () => [entry("old", "user", 30_000), entry("paste", "user", 240_000), entry("result", "toolResult", 1_000)];
const batch = [
  { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] },
  { role: "toolResult", toolCallId: "a", content: [] },
];

function harness(config?: object) {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-compact-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  if (config) {
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(join(dir, "extensions", "pi-loop-compact.json"), JSON.stringify({ version: 1, ...config }));
  }
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let command: (args: string, ctx: ExtensionContext) => Promise<void>;
  const state = {
    usage: { tokens: 240_000, contextWindow: 272_000, percent: 88 } as ContextUsage | undefined,
    entries: compactable() as unknown[],
    session: "s1",
    idle: true,
    compacts: [] as CompactOptions[],
    sent: [] as unknown[],
    notes: [] as Array<{ message: string; type: string }>,
    aborts: 0,
  };
  const ctx = {
    cwd: dir,
    model: { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272_000 },
    ui: {
      theme: { fg: (_color: string, value: string) => value },
      setStatus() {},
      notify(message: string, type: string) { state.notes.push({ message, type }); },
    },
    sessionManager: {
      getSessionId: () => state.session,
      buildSessionProjection: () => ({ entries: state.entries }),
      getBranch: () => [{ type: "message" }],
    },
    getContextUsage: () => state.usage,
    isIdle: () => state.idle,
    compact(options: CompactOptions) { state.compacts.push(options); },
    abort() { state.aborts++; },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { hooks.set(name, handler); },
    registerCommand(name: string, options: { handler: typeof command }) {
      assert.equal(name, "loop-compact");
      command = options.handler;
    },
    sendUserMessage(content: unknown) { state.sent.push(content); },
  } as unknown as ExtensionAPI;
  loopCompact(pi);
  hooks.get("session_start")!({}, ctx);
  return {
    state,
    ctx,
    batch: (messages: unknown[] = batch) => hooks.get("context")!({ type: "context", messages }, ctx),
    hook: (name: string) => hooks.get(name)!({}, ctx),
    run: (args: string) => command!(args, ctx),
    tick: () => new Promise<void>((done) => setImmediate(done)),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a complete tool batch over the threshold compacts once and resumes once", async () => {
  const h = harness();
  try {
    h.batch();
    h.batch();
    assert.equal(h.state.compacts.length, 1, "no second compaction while one is running");
    assert.equal(h.state.aborts, 0, "ctx.compact owns the abort");
    assert.match(h.state.compacts[0].customInstructions ?? "", /paused between tool calls/);

    const done = h.state.compacts[0].onComplete!({} as never) as unknown as Promise<void>;
    h.state.compacts[0].onComplete!({} as never);
    await done;
    assert.deepEqual(h.state.sent, [CONTINUE_PROMPT]);
  } finally {
    h.cleanup();
  }
});

test("queued input, disabled resume and stale sessions suppress the continuation", async () => {
  for (const setup of [
    (h: ReturnType<typeof harness>) => { h.state.idle = false; },
    (h: ReturnType<typeof harness>) => { h.hook("session_start"); },
    (h: ReturnType<typeof harness>) => { h.state.session = "s2"; },
  ]) {
    const h = harness();
    try {
      h.batch();
      setup(h);
      await h.state.compacts[0].onComplete!({} as never);
      await h.tick();
      assert.deepEqual(h.state.sent, []);
    } finally {
      h.cleanup();
    }
  }
  const h = harness({ resume: false });
  try {
    h.batch();
    await h.state.compacts[0].onComplete!({} as never);
    assert.deepEqual(h.state.sent, []);
  } finally {
    h.cleanup();
  }
});

test("unknown or low usage and incomplete batches do not trigger", () => {
  const h = harness();
  try {
    h.state.usage = { tokens: null, contextWindow: 272_000, percent: null };
    h.batch();
    h.state.usage = { tokens: 200_000, contextWindow: 272_000, percent: 84 };
    h.batch();
    h.state.usage = { tokens: 240_000, contextWindow: 272_000, percent: 88 };
    h.batch(batch.slice(0, 1));
    assert.equal(h.state.compacts.length, 0);
  } finally {
    h.cleanup();
  }
});

test("an uncompactable session is skipped without aborting, announced once per cut point", () => {
  const h = harness();
  try {
    h.state.entries = oversizedFirst();
    h.batch();
    h.batch();
    assert.equal(h.state.compacts.length, 0);
    assert.equal(h.state.aborts, 0);
    const skips = h.state.notes.filter((item) => item.message.includes("跳过自动压缩"));
    assert.equal(skips.length, 1);
    assert.match(skips[0].message, /没有可总结的部分/);

    h.state.entries = futile();
    h.batch();
    assert.equal(h.state.compacts.length, 0);
    assert.match(h.state.notes.at(-1)!.message, /超过了 85% 阈值/);
  } finally {
    h.cleanup();
  }
});

test("a failed compaction resumes uncompacted and is not retried at the same cut point", async () => {
  const h = harness();
  try {
    h.batch();
    await h.state.compacts[0].onError!(new Error("HTTP 400"));
    await h.tick();
    assert.match(h.state.notes.at(-1)!.message, /压缩失败：HTTP 400，任务不压缩继续/);
    assert.deepEqual(h.state.sent, [CONTINUE_PROMPT]);

    h.batch();
    assert.equal(h.state.compacts.length, 1);

    h.state.entries = [...compactable(), entry("newer", "user", 30_000)];
    h.batch();
    assert.equal(h.state.compacts.length, 2, "a new cut point is tried again");
  } finally {
    h.cleanup();
  }
});

test("/loop-compact now compacts without inventing a continuation and refuses empty plans", async () => {
  const h = harness();
  try {
    await h.run("now");
    assert.equal(h.state.compacts.length, 1);
    await h.state.compacts[0].onComplete!({} as never);
    await h.tick();
    assert.deepEqual(h.state.sent, [], "an idle session was not interrupted");

    h.state.entries = oversizedFirst();
    await h.run("now");
    assert.equal(h.state.compacts.length, 1);
    assert.match(h.state.notes.at(-1)!.message, /没有压缩/);

    h.state.entries = futile();
    await h.run("now");
    assert.equal(h.state.compacts.length, 2, "an explicit request may compact a futile plan");
  } finally {
    h.cleanup();
  }
});

test("invalid configuration disables automatic compaction and shows in status", async () => {
  const h = harness({ threshold: 120 });
  try {
    h.batch();
    assert.equal(h.state.compacts.length, 0);
    assert.equal(h.state.notes[0].type, "error");
    await h.run("status");
    assert.match(h.state.notes.at(-1)!.message, /配置错误/);
  } finally {
    h.cleanup();
  }
});

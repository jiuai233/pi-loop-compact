// End-to-end checks against the installed `pi` binary (override with PI_BINARY), driven over RPC.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const PI = process.env.PI_BINARY ?? "pi";
const ROOT = join(import.meta.dirname, "..");
const skip = spawnSync(PI, ["--version"]).status !== 0 && `${PI} is not installed`;

type Event = Record<string, any>;

async function runPi(prompt: string, compaction: object, config: object, done: (event: Event) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-compact-rpc-"));
  mkdirSync(join(dir, "extensions"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: true, ...compaction } }));
  writeFileSync(join(dir, "extensions", "pi-loop-compact.json"), JSON.stringify({ version: 1, ...config }));
  const logFile = join(dir, "provider.log");
  const child = spawn(PI, [
    "--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--no-extensions",
    "-e", join(ROOT, "test", "fixtures", "mock-provider.ts"), "-e", ROOT,
    "--model", "loop-compact-test/mock",
  ], { cwd: ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_LOOP_COMPACT_TEST_LOG: logFile, NO_COLOR: "1" } });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const events: Event[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${stderr.join("")}\n${events.map((e) => e.type).join(",")}`)), 20_000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const event = JSON.parse(line) as Event;
        events.push(event);
        if (done(event)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stdin.write(`${JSON.stringify({ id: "run", type: "prompt", message: prompt })}\n`);
    });
    // Let Pi finish settling so late events (e.g. stray compactions) would be caught.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const calls = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : [];
    return { events, calls };
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const notices = (events: Event[], pattern: RegExp) =>
  events.filter((event) => event.type === "extension_ui_request" && event.method === "notify" && pattern.test(event.message));
const finalText = (text: string) => (event: Event) => event.type === "message_end" && event.message?.role === "assistant" &&
  JSON.stringify(event.message.content).includes(text);

test("Pi compacts between tool batches and resumes the task", { skip, timeout: 30_000 }, async () => {
  // keepRecentTokens 101 keeps only the last tool round, so the earlier round is summarized.
  const { events, calls } = await runPi("start the mock loop", { keepRecentTokens: 101, reserveTokens: 100 }, { threshold: 50 }, finalText("mock-resumed"));
  const end = events.find((event) => event.type === "compaction_end");
  assert.ok(end?.result, JSON.stringify(end));
  assert.deepEqual(calls, ["first-call", "second-call", "summary", "resumed"], "the uncompacted post-tool request never ran");
  assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
});

test("Pi keeps running without aborting when the first message cannot be compacted", { skip, timeout: 30_000 }, async () => {
  // A ~600-token prompt with keepRecentTokens 500: Pi could only ever keep the prompt whole.
  const { events, calls } = await runPi(`start the mock loop ${"y".repeat(2_400)}`, { keepRecentTokens: 500, reserveTokens: 100 }, { threshold: 40 }, finalText("mock-finished"));
  assert.equal(notices(events, /跳过自动压缩/).length, 1);
  assert.deepEqual(events.filter((event) => event.type === "compaction_start"), []);
  assert.deepEqual(events.filter((event) => event.type === "message_end" && event.message?.stopReason === "aborted"), []);
  assert.deepEqual(calls, ["first-call", "second-call", "finished"]);
  assert.deepEqual(events.filter((event) => event.type === "extension_error"), []);
});

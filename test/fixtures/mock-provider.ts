// A scripted provider and tool for the RPC tests: two tool rounds, then a final answer.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function log(kind: string): void {
  if (process.env.PI_LOOP_COMPACT_TEST_LOG) appendFileSync(process.env.PI_LOOP_COMPACT_TEST_LOG, `${kind}\n`);
}

function textOf(message: Context["messages"][number] | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Reply with fixed usage so the test controls exactly what Pi reports as context size. */
function reply(model: Model<any>, content: AssistantMessage["content"], inputTokens: number) {
  const stream = createAssistantMessageEventStream();
  const stopReason = content[0]?.type === "toolCall" ? "toolUse" : "stop";
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: inputTokens,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

const toolCall = (id: string) => [{ type: "toolCall" as const, id, name: "emit_blob", arguments: {} }];

function respond(model: Model<any>, context: Context) {
  const last = context.messages.at(-1);
  const text = textOf(last);
  // Pi wraps history summaries in <conversation> and split-turn prefixes in "# Conversation".
  if (text.includes("<conversation>") || text.startsWith("# Conversation\n")) {
    log("summary");
    return reply(model, [{ type: "text", text: "## Goal\nFinish the mock task.\n\n## Next Steps\n1. Continue." }], 50);
  }
  if (text.includes("[pi-loop-compact]")) {
    log("resumed");
    return reply(model, [{ type: "text", text: "mock-resumed" }], 200);
  }
  if (last?.role === "toolResult" && last.toolCallId === "blob-1") {
    log("second-call");
    return reply(model, toolCall("blob-2"), 600);
  }
  if (last?.role === "toolResult") {
    log("finished");
    return reply(model, [{ type: "text", text: "mock-finished" }], 900);
  }
  log("first-call");
  return reply(model, toolCall("blob-1"), 300);
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider("loop-compact-test", {
    name: "Loop Compact Test",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "test-key",
    api: "openai-completions",
    streamSimple: respond,
    models: [{
      id: "mock",
      name: "Mock",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 200,
    }],
  });
  pi.registerTool({
    name: "emit_blob",
    label: "Emit Blob",
    description: "Return 100 tokens of filler for the pi-loop-compact RPC tests.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "x".repeat(400) }], details: {} };
    },
  });
}

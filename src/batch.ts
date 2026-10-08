import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

/**
 * True when the context ends with an assistant tool-call message followed by exactly one
 * result per call, in any order. Compacting anywhere else would split a tool exchange.
 */
export function endsWithToolBatch(messages: readonly Message[]): boolean {
  const results = new Set<string>();
  let index = messages.length - 1;
  for (; index >= 0 && messages[index].role === "toolResult"; index--) {
    const id = (messages[index] as { toolCallId?: unknown }).toolCallId;
    if (typeof id !== "string" || results.has(id)) return false;
    results.add(id);
  }
  const assistant = messages[index];
  if (results.size === 0 || assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return false;

  const calls = assistant.content.filter((block) => block.type === "toolCall").map((block) => block.id);
  return calls.length === results.size && calls.every((id) => results.has(id));
}

import assert from "node:assert/strict";
import test from "node:test";
import { endsWithToolBatch } from "../src/batch.ts";

const call = (...ids: string[]) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })) });
const result = (id: unknown) => ({ role: "toolResult", toolCallId: id, content: [] });
const check = (...messages: unknown[]) => endsWithToolBatch(messages as never);

test("a batch is complete only when every call has exactly one result", () => {
  assert.equal(check(call("a"), result("a")), true);
  assert.equal(check(call("a", "b"), result("b"), result("a")), true, "results may arrive in any order");
  assert.equal(check(call("a", "b"), result("a")), false, "missing result");
  assert.equal(check(call("a"), result("a"), result("a")), false, "duplicate result");
  assert.equal(check(call("a"), result("b")), false, "foreign result");
  assert.equal(check(call("a"), result(1)), false, "malformed result id");
});

test("the context must end at the tool results of the latest assistant message", () => {
  assert.equal(check(call("a"), result("a"), { role: "user", content: "next" }), false);
  assert.equal(check(call("a")), false);
  assert.equal(check({ role: "user", content: "x" }, result("a")), false);
  assert.equal(check(), false);
  assert.equal(check({ role: "assistant", content: [{ type: "text", text: "hi" }] }, result("a")), false);
});

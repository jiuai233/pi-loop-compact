import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SETTINGS, readSettings } from "../src/settings.ts";

test("missing and partial files fall back to defaults; invalid values are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-compact-settings-"));
  const file = join(dir, "pi-loop-compact.json");
  try {
    assert.deepEqual(readSettings(file), DEFAULT_SETTINGS);
    writeFileSync(file, JSON.stringify({ version: 1, threshold: 70 }));
    assert.deepEqual(readSettings(file), { ...DEFAULT_SETTINGS, threshold: 70 });
    for (const bad of [{ threshold: 100 }, { threshold: 0 }, { threshold: "80" }, { enabled: "yes" }, { version: 2 }]) {
      writeFileSync(file, JSON.stringify({ version: 1, ...bad }));
      assert.throws(() => readSettings(file), /配置格式无效/, JSON.stringify(bad));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

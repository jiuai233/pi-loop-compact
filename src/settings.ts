import { existsSync, readFileSync } from "node:fs";

export interface Settings {
  version: 1;
  /** Compact automatically between tool batches. */
  enabled: boolean;
  /** Context usage percentage that triggers compaction, strictly between 0 and 100. */
  threshold: number;
  /** Send a continuation message after a mid-run compaction. */
  resume: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  enabled: true,
  threshold: 85,
  resume: true,
});

export function readSettings(file: string): Settings {
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
  const settings = { ...DEFAULT_SETTINGS, ...data };
  if (settings.version !== 1 || typeof settings.enabled !== "boolean" || typeof settings.resume !== "boolean" ||
      typeof settings.threshold !== "number" || !(settings.threshold > 0 && settings.threshold < 100)) {
    throw new Error("pi-loop-compact 配置格式无效：threshold 需在 0 到 100 之间，enabled、resume 为布尔值");
  }
  return settings;
}

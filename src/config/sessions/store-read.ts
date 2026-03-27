import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import type { SessionEntry } from "./types.js";

const SessionStoreSchema = z.record(z.string(), z.unknown()) as z.ZodType<
  Record<string, SessionEntry | undefined>
>;

/** Sibling directory name for the per-session store layout. */
const DIR_STORE_NAME = "sessions.d";

/**
 * Attempt to load sessions from the directory store (sessions.d/) that lives
 * alongside the legacy sessions.json path.  Returns undefined when no
 * directory store exists so the caller can fall back to legacy mode.
 */
function readDirectoryStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> | undefined {
  const storeDir = path.join(path.dirname(storePath), DIR_STORE_NAME);
  let entries: string[];
  try {
    const stat = fs.statSync(storeDir);
    if (!stat.isDirectory()) {
      return undefined;
    }
    entries = fs.readdirSync(storeDir);
  } catch {
    return undefined;
  }
  const store: Record<string, SessionEntry | undefined> = {};
  for (const fileName of entries) {
    if (!fileName.endsWith(".json") || fileName.startsWith(".")) {
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(storeDir, fileName), "utf-8");
      if (!raw || raw.length === 0) {
        continue;
      }
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Reverse percent-encoding used by sanitizeSessionKey.
        const sessionKey = fileName
          .slice(0, -5)
          .replace(/%3A/g, ":")
          .replace(/%5C/g, "\\")
          .replace(/%2F/g, "/")
          .replace(/%25/g, "%");
        store[sessionKey] = parsed as SessionEntry;
      }
    } catch {
      // Skip malformed entries — read-only helper should never throw.
    }
  }
  return store;
}

export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    return safeParseJsonWithSchema(SessionStoreSchema, raw) ?? {};
  } catch {
    // Legacy JSON missing or unreadable — try directory store fallback.
    return readDirectoryStoreReadOnly(storePath) ?? {};
  }
}

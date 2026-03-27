import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../../../config/paths.js";
import { openBoundaryFile } from "../../../infra/boundary-file-read.js";
import { formatErrorMessage, hasErrnoCode } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveUserPath } from "../../../utils.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const MAX_SHARED_FILE_BYTES = 2 * 1024 * 1024;
const log = createSubsystemLogger("shared-bootstrap");

/**
 * Read SHARED_*.md files from a directory, returning bootstrap file entries.
 * Gracefully handles missing/unreadable directories.
 * @param dir      Absolute path to scan
 * @param rootPath Boundary root for openBoundaryFile (prevents path traversal)
 */
async function loadSharedFiles(
  dir: string,
  rootPath: string,
): Promise<{ name: string; path: string; content: string; missing: false }[]> {
  let dirents: syncFs.Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT") || hasErrnoCode(err, "ENOTDIR") || hasErrnoCode(err, "ELOOP")) {
      return [];
    }
    throw err;
  }

  const sharedFiles = dirents
    .filter((d) => d.isFile() && d.name.startsWith("SHARED_") && d.name.endsWith(".md"))
    .map((d) => d.name)
    .toSorted();

  const results: { name: string; path: string; content: string; missing: false }[] = [];
  for (const file of sharedFiles) {
    const filePath = path.join(dir, file);
    const opened = await openBoundaryFile({
      absolutePath: filePath,
      rootPath,
      boundaryLabel: "shared bootstrap",
      maxBytes: MAX_SHARED_FILE_BYTES,
      allowedType: "file",
    });
    if (!opened.ok) {
      const errDetail = opened.error != null ? formatErrorMessage(opened.error) : "";
      log.warn(`skipping ${file}: ${opened.reason}${errDetail ? ` — ${errDetail}` : ""}`);
      continue;
    }
    try {
      const content = syncFs.readFileSync(opened.fd, "utf-8");
      results.push({ name: file, path: filePath, content, missing: false });
    } catch (readErr: unknown) {
      log.warn(`skipping ${file}: read failed — ${formatErrorMessage(readErr)}`);
    } finally {
      syncFs.closeSync(opened.fd);
    }
  }
  return results;
}

const sharedBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const sharedDir = path.join(STATE_DIR, "shared");

  // Resolve the agent's sharedBootstrapPath from config (if any).
  const agentEntry = event.context.cfg?.agents?.list?.find((a) => a.id === event.context.agentId);
  const sandboxPath = agentEntry?.sharedBootstrapPath
    ? resolveUserPath(agentEntry.sharedBootstrapPath)
    : undefined;

  if (sandboxPath != null) {
    // Two-tier mode: Tier 1 (global top-level only) + Tier 2 (sandbox path).
    // Intentionally does NOT re-apply filterBootstrapFilesForSession so
    // shared files reach subagent and cron sessions unconditionally.
    // Also intentionally bypasses applyContextModeFilter — shared files
    // are injected in all modes including lightweight cron/default runs.
    const tier1 = await loadSharedFiles(sharedDir, sharedDir);
    const tier2 = await loadSharedFiles(sandboxPath, sandboxPath);
    for (const file of [...tier1, ...tier2]) {
      event.context.bootstrapFiles.push(file);
    }
  } else {
    // Default mode: load everything from the global shared dir (backward compatible).
    // Intentionally does NOT re-apply filterBootstrapFilesForSession so
    // shared files reach subagent and cron sessions unconditionally.
    // Also intentionally bypasses applyContextModeFilter — shared files
    // are injected in all modes including lightweight cron/default runs.
    // Hook ordering safety: bootstrap-extra-files only filters its own
    // extras through filterBootstrapFilesForSession, preserving files
    // already in context.bootstrapFiles regardless of execution order.
    const files = await loadSharedFiles(sharedDir, sharedDir);
    for (const file of files) {
      event.context.bootstrapFiles.push(file);
    }
  }
};

export default sharedBootstrapHook;

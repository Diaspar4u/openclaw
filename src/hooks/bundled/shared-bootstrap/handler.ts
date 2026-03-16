import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../../../config/paths.js";
import { openBoundaryFile } from "../../../infra/boundary-file-read.js";
import { formatErrorMessage, hasErrnoCode } from "../../../infra/errors.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const MAX_SHARED_FILE_BYTES = 2 * 1024 * 1024;
const log = createSubsystemLogger("shared-bootstrap");

const sharedBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const sharedDir = path.join(STATE_DIR, "shared");

  let dirents: syncFs.Dirent[];
  try {
    dirents = await fs.readdir(sharedDir, { withFileTypes: true });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT") || hasErrnoCode(err, "ENOTDIR") || hasErrnoCode(err, "ELOOP")) {
      return;
    }
    throw err;
  }

  const sharedFiles = dirents
    .filter((d) => d.isFile() && d.name.startsWith("SHARED_") && d.name.endsWith(".md"))
    .map((d) => d.name)
    .toSorted();
  if (sharedFiles.length === 0) {
    return;
  }

  for (const file of sharedFiles) {
    const filePath = path.join(sharedDir, file);
    const opened = await openBoundaryFile({
      absolutePath: filePath,
      rootPath: sharedDir,
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
      // Intentionally does NOT re-apply filterBootstrapFilesForSession so
      // shared files reach subagent and cron sessions unconditionally.
      // Also intentionally bypasses applyContextModeFilter — shared files
      // are injected in all modes including lightweight cron/default runs.
      // Hook ordering safety: bootstrap-extra-files only filters its own
      // extras through filterBootstrapFilesForSession, preserving files
      // already in context.bootstrapFiles regardless of execution order.
      event.context.bootstrapFiles.push({
        name: file,
        path: filePath,
        content,
        missing: false,
      });
    } catch (readErr: unknown) {
      log.warn(`skipping ${file}: read failed — ${formatErrorMessage(readErr)}`);
    } finally {
      syncFs.closeSync(opened.fd);
    }
  }
};

export default sharedBootstrapHook;

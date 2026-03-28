import type { Stats } from "node:fs";
import fs from "node:fs/promises";
export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

function hasErrnoCode(err: unknown, code: string): boolean {
  return Boolean(
    err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === code,
  );
}

export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" } {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as Partial<NodeJS.ErrnoException>).code === "ENOENT",
  );
}

export async function statRegularFile(absPath: string): Promise<RegularFileStatResult> {
  let stat: Stats;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return { missing: true };
    }
    // ELOOP (circular symlink) and ENOTDIR (path component not a directory)
    // mean the target is effectively unreachable — treat as missing.
    if (hasErrnoCode(err, "ELOOP") || hasErrnoCode(err, "ENOTDIR")) {
      return { missing: true };
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error("path required");
  }
  return { missing: false, stat };
}

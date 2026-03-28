import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

const mockStateDir = vi.hoisted(() => ({ value: "" }));
vi.mock("../../../config/paths.js", () => ({
  get STATE_DIR() {
    return mockStateDir.value;
  },
}));

// Import after mock setup — STATE_DIR is read at call time (not module load)
import handler from "./handler.js";

function createBootstrapContext(params: {
  workspaceDir: string;
  sessionKey: string;
  agentId?: string;
  cfg?: AgentBootstrapHookContext["cfg"];
}): AgentBootstrapHookContext {
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: [],
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
  };
}

describe("shared-bootstrap hook", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-bootstrap-"));
    mockStateDir.value = tempDir;
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does nothing when shared directory does not exist", async () => {
    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("does nothing when shared directory is empty", async () => {
    await fs.mkdir(path.join(tempDir, "shared"), { recursive: true });
    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("does nothing when no SHARED_*.md files exist", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "RULES.md"), "no prefix", "utf-8");
    await fs.writeFile(path.join(sharedDir, "notes.txt"), "not md", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("injects SHARED_*.md files from shared directory", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared rules", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "shared soul", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(2);

    expect(context.bootstrapFiles[0].name).toBe("SHARED_RULES.md");
    expect(context.bootstrapFiles[0].content).toBe("shared rules");
    expect(context.bootstrapFiles[0].path).toBe(path.join(sharedDir, "SHARED_RULES.md"));
    expect(context.bootstrapFiles[0].missing).toBe(false);

    expect(context.bootstrapFiles[1].name).toBe("SHARED_SOUL.md");
    expect(context.bootstrapFiles[1].content).toBe("shared soul");
    expect(context.bootstrapFiles[1].path).toBe(path.join(sharedDir, "SHARED_SOUL.md"));
    expect(context.bootstrapFiles[1].missing).toBe(false);
  });

  it("sorts files alphabetically", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_C.md"), "c", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_A.md"), "a", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_B.md"), "b", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles.map((f) => f.name)).toEqual([
      "SHARED_A.md",
      "SHARED_B.md",
      "SHARED_C.md",
    ]);
  });

  it("ignores files without SHARED_ prefix", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SOUL.md"), "not shared", "utf-8");
    await fs.writeFile(path.join(sharedDir, "config.json"), "{}", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].name).toBe("SHARED_RULES.md");
  });

  it("throws when shared directory exists but is unreadable", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.chmod(sharedDir, 0o000);

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);

    try {
      await expect(handler(event)).rejects.toThrow();
    } finally {
      await fs.chmod(sharedDir, 0o755);
    }
  });

  it("skips files that cannot be opened (EACCES)", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_GOOD.md"), "good", "utf-8");
    const filePath = path.join(sharedDir, "SHARED_BROKEN.md");
    await fs.writeFile(filePath, "content", "utf-8");
    await fs.chmod(filePath, 0o000);

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);

    try {
      await handler(event);
      // SHARED_BROKEN.md skipped (openSync EACCES), SHARED_GOOD.md loaded
      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_GOOD.md");
    } finally {
      await fs.chmod(filePath, 0o644);
    }
  });

  it("skips symlinks pointing outside shared directory", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    const outsideFile = path.join(tempDir, "secret.md");
    await fs.writeFile(outsideFile, "secret content", "utf-8");
    await fs.symlink(outsideFile, path.join(sharedDir, "SHARED_ESCAPE.md"));
    await fs.writeFile(path.join(sharedDir, "SHARED_LEGIT.md"), "legit", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    // Symlink filtered out by dirent.isFile() (returns false for symlinks)
    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].name).toBe("SHARED_LEGIT.md");
  });

  it("includes empty files with empty-string content", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_EMPTY.md"), "", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].name).toBe("SHARED_EMPTY.md");
    expect(context.bootstrapFiles[0].content).toBe("");
  });

  it("does nothing when shared path is a regular file (ENOTDIR)", async () => {
    await fs.writeFile(path.join(tempDir, "shared"), "not a directory", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("ignores directory entries matching SHARED_*.md pattern", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.mkdir(path.join(sharedDir, "SHARED_DIR.md"), { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_LEGIT.md"), "legit", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].name).toBe("SHARED_LEGIT.md");
  });

  it("skips files when readFileSync throws after successful open", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_FAIL.md"), "fail", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_GOOD.md"), "good", "utf-8");

    let fdReadAttempt = 0;
    const origReadFileSync = syncFs.readFileSync.bind(syncFs);
    vi.spyOn(syncFs, "readFileSync").mockImplementation(((
      pathOrFd: number | string | Buffer | URL,
      encoding: BufferEncoding,
    ) => {
      // Only intercept fd-based reads (what the handler uses); pass path-based reads through
      if (typeof pathOrFd === "number") {
        fdReadAttempt++;
        if (fdReadAttempt === 1) {
          // Simulate hardware read error on first file (SHARED_FAIL sorts before SHARED_GOOD)
          const err = new Error("Input/output error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
      }
      return origReadFileSync(pathOrFd as number, encoding);
    }) as typeof syncFs.readFileSync);

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);

    try {
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_GOOD.md");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shared files survive in subagent sessions", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared rules", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:subagent:abc",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0].name).toBe("SHARED_RULES.md");
  });

  // =========================================================================
  // Two-tier filtering (sharedBootstrapPath)
  // =========================================================================

  describe("sharedBootstrapPath filtering", () => {
    let sandboxDir: string;

    beforeEach(async () => {
      sandboxDir = path.join(tempDir, "sandbox-shared");
      await fs.mkdir(sandboxDir, { recursive: true });
    });

    function cfgWithSandboxPath(
      agentId: string,
      sandboxPath: string,
    ): AgentBootstrapHookContext["cfg"] {
      return {
        agents: {
          list: [{ id: agentId, sharedBootstrapPath: sandboxPath }],
        },
      } as AgentBootstrapHookContext["cfg"];
    }

    it("loads only global top-level + sandbox files when sharedBootstrapPath is set", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "global soul", "utf-8");
      await fs.writeFile(path.join(sandboxDir, "SHARED_POLICY.md"), "sandbox policy", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:main",
        agentId: "eva",
        cfg: cfgWithSandboxPath("eva", sandboxDir),
      });

      const event = createHookEvent("agent", "bootstrap", "agent:eva:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(2);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
      expect(context.bootstrapFiles[0].content).toBe("global soul");
      expect(context.bootstrapFiles[1].name).toBe("SHARED_POLICY.md");
      expect(context.bootstrapFiles[1].content).toBe("sandbox policy");
    });

    it("sandbox path does not load non-SHARED_*.md files", async () => {
      await fs.writeFile(path.join(sandboxDir, "SHARED_OK.md"), "ok", "utf-8");
      await fs.writeFile(path.join(sandboxDir, "PRIVATE.md"), "private", "utf-8");
      await fs.writeFile(path.join(sandboxDir, "config.json"), "{}", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:main",
        agentId: "eva",
        cfg: cfgWithSandboxPath("eva", sandboxDir),
      });

      const event = createHookEvent("agent", "bootstrap", "agent:eva:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_OK.md");
    });

    it("sandbox path to non-existent dir loads only global tier 1", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:main",
        agentId: "eva",
        cfg: cfgWithSandboxPath("eva", path.join(tempDir, "nonexistent")),
      });

      const event = createHookEvent("agent", "bootstrap", "agent:eva:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
    });

    it("sandbox path to empty dir loads only global tier 1", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:main",
        agentId: "eva",
        cfg: cfgWithSandboxPath("eva", sandboxDir),
      });

      const event = createHookEvent("agent", "bootstrap", "agent:eva:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
    });

    it("no sharedBootstrapPath loads all files from global dir (backward compat)", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");
      await fs.writeFile(path.join(sharedDir, "SHARED_TOPICS.md"), "topics", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:main:main",
        agentId: "main",
        cfg: { agents: { list: [{ id: "main" }] } } as AgentBootstrapHookContext["cfg"],
      });

      const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(2);
      expect(context.bootstrapFiles.map((f) => f.name)).toEqual([
        "SHARED_SOUL.md",
        "SHARED_TOPICS.md",
      ]);
    });

    it("different agents get different sandbox files", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "global soul", "utf-8");

      const evaDir = path.join(tempDir, "eva-shared");
      const bobDir = path.join(tempDir, "bob-shared");
      await fs.mkdir(evaDir, { recursive: true });
      await fs.mkdir(bobDir, { recursive: true });
      await fs.writeFile(path.join(evaDir, "SHARED_POLICY.md"), "eva policy", "utf-8");
      await fs.writeFile(path.join(bobDir, "SHARED_POLICY.md"), "bob policy", "utf-8");

      const evaCfg = {
        agents: {
          list: [
            { id: "eva", sharedBootstrapPath: evaDir },
            { id: "bob", sharedBootstrapPath: bobDir },
          ],
        },
      } as AgentBootstrapHookContext["cfg"];

      // Eva's bootstrap
      const evaContext = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:main",
        agentId: "eva",
        cfg: evaCfg,
      });
      const evaEvent = createHookEvent("agent", "bootstrap", "agent:eva:main", evaContext);
      await handler(evaEvent);

      expect(evaContext.bootstrapFiles).toHaveLength(2);
      expect(evaContext.bootstrapFiles[0].content).toBe("global soul");
      expect(evaContext.bootstrapFiles[1].content).toBe("eva policy");

      // Bob's bootstrap
      const bobContext = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:bob:main",
        agentId: "bob",
        cfg: evaCfg,
      });
      const bobEvent = createHookEvent("agent", "bootstrap", "agent:bob:main", bobContext);
      await handler(bobEvent);

      expect(bobContext.bootstrapFiles).toHaveLength(2);
      expect(bobContext.bootstrapFiles[0].content).toBe("global soul");
      expect(bobContext.bootstrapFiles[1].content).toBe("bob policy");
    });

    it("two-tier mode works in subagent sessions", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");
      await fs.writeFile(path.join(sandboxDir, "SHARED_RULES.md"), "sandbox rules", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:eva:subagent:abc",
        agentId: "eva",
        cfg: cfgWithSandboxPath("eva", sandboxDir),
      });

      const event = createHookEvent("agent", "bootstrap", "agent:eva:subagent:abc", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(2);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
      expect(context.bootstrapFiles[1].name).toBe("SHARED_RULES.md");
    });

    it("falls back to default mode when agentId is not in config list", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:unknown:main",
        agentId: "unknown",
        cfg: { agents: { list: [{ id: "main" }] } } as AgentBootstrapHookContext["cfg"],
      });

      const event = createHookEvent("agent", "bootstrap", "agent:unknown:main", context);
      await handler(event);

      // No sharedBootstrapPath found for "unknown" agent -> default mode
      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
    });

    it("falls back to default mode when cfg is not provided", async () => {
      const sharedDir = path.join(tempDir, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "soul", "utf-8");

      const context = createBootstrapContext({
        workspaceDir: tempDir,
        sessionKey: "agent:main:main",
        agentId: "main",
        // No cfg provided
      });

      const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
      await handler(event);

      expect(context.bootstrapFiles).toHaveLength(1);
      expect(context.bootstrapFiles[0].name).toBe("SHARED_SOUL.md");
    });
  });
});

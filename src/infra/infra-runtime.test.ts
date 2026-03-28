import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  __testing,
  consumeGatewaySigusr1RestartAuthorization,
  emitGatewayRestart,
  isGatewaySigusr1RestartExternallyAllowed,
  markGatewaySigusr1RestartHandled,
  SCHEDULED_RESTART_MAX_WAIT_MS,
  scheduleGatewaySigusr1Restart,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "./restart.js";
import { listTailnetAddresses } from "./tailnet.js";

describe("infra runtime", () => {
  function setupRestartSignalSuite() {
    beforeEach(() => {
      __testing.resetSigusr1State();
      vi.useFakeTimers();
      vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(async () => {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      vi.restoreAllMocks();
      __testing.resetSigusr1State();
    });
  }

  describe("restart authorization", () => {
    setupRestartSignalSuite();

    it("authorizes exactly once when scheduled restart emits", async () => {
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      scheduleGatewaySigusr1Restart({ delayMs: 0 });

      // No pre-authorization before the scheduled emission fires.
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
      expect(consumeGatewaySigusr1RestartAuthorization()).toBe(false);

      await vi.runAllTimersAsync();
    });

    it("tracks external restart policy", () => {
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(false);
      setGatewaySigusr1RestartPolicy({ allowExternal: true });
      expect(isGatewaySigusr1RestartExternallyAllowed()).toBe(true);
    });

    it("suppresses duplicate emit until the restart cycle is marked handled", () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        expect(emitGatewayRestart()).toBe(true);
        expect(emitGatewayRestart()).toBe(false);
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);

        markGatewaySigusr1RestartHandled();

        expect(emitGatewayRestart()).toBe(true);
        const sigusr1Emits = emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1");
        expect(sigusr1Emits.length).toBe(2);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("coalesces duplicate scheduled restarts into a single pending timer", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "first" });
        const second = scheduleGatewaySigusr1Restart({ delayMs: 1_000, reason: "second" });

        expect(first.coalesced).toBe(false);
        expect(second.coalesced).toBe(true);

        await vi.advanceTimersByTimeAsync(999);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        await vi.advanceTimersByTimeAsync(1);
        const sigusr1Emits = emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1");
        expect(sigusr1Emits.length).toBe(1);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("applies restart cooldown between emitted restart cycles", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        const first = scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "first" });
        expect(first.coalesced).toBe(false);
        expect(first.delayMs).toBe(0);

        await vi.advanceTimersByTimeAsync(0);
        expect(consumeGatewaySigusr1RestartAuthorization()).toBe(true);
        markGatewaySigusr1RestartHandled();

        const second = scheduleGatewaySigusr1Restart({ delayMs: 0, reason: "second" });
        expect(second.coalesced).toBe(false);
        expect(second.delayMs).toBe(30_000);
        expect(second.cooldownMsApplied).toBe(30_000);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1").length).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(emitSpy.mock.calls.filter((args) => args[0] === "SIGUSR1").length).toBe(2);
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });
  });

  describe("pre-restart deferral check", () => {
    setupRestartSignalSuite();

    it("emits SIGUSR1 immediately when no deferral check is registered", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 immediately when deferral check returns 0", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 0);
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("defers SIGUSR1 until deferral check returns 0", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        let pending = 2;
        setPreRestartDeferralCheck(() => pending);
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        // After initial delay fires, deferral check returns 2 — should NOT emit yet
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // After one poll (500ms), still pending
        await vi.advanceTimersByTimeAsync(500);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // Drain pending work
        pending = 0;
        await vi.advanceTimersByTimeAsync(500);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("waits indefinitely when maxWaitMs is 0 (gateway tool path)", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        let pending = 5;
        setPreRestartDeferralCheck(() => pending);
        scheduleGatewaySigusr1Restart({ delayMs: 0, maxWaitMs: 0 });

        // Fire initial timeout
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // Advance well past the scheduled restart max — should still NOT restart
        // (default maxWaitMs=0 means infinite wait for gateway tool path)
        await vi.advanceTimersByTimeAsync(600_000);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // Drain pending work — now it restarts
        pending = 0;
        await vi.advanceTimersByTimeAsync(500);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("times out at SCHEDULED_RESTART_MAX_WAIT_MS boundary by default", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5);
        scheduleGatewaySigusr1Restart({ delayMs: 0 });

        // Fire initial timeout — starts deferral polling
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).not.toHaveBeenCalledWith("SIGUSR1");

        // At exactly SCHEDULED_RESTART_MAX_WAIT_MS, >= triggers timeout
        await vi.advanceTimersByTimeAsync(SCHEDULED_RESTART_MAX_WAIT_MS);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("upgrades pending non-force restart to force when force request arrives", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        const first = scheduleGatewaySigusr1Restart({ delayMs: 100, reason: "non-force" });
        expect(first.coalesced).toBe(false);

        // Force request should NOT coalesce — should reschedule with force
        const second = scheduleGatewaySigusr1Restart({
          delayMs: 100,
          reason: "force-upgrade",
          force: true,
        });
        expect(second.coalesced).toBe(false);

        // Fire the rescheduled timer — force skips deferral entirely
        await vi.advanceTimersByTimeAsync(100);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("does not downgrade a pending force restart when a non-force request arrives earlier", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        // Schedule force restart 10 seconds out
        scheduleGatewaySigusr1Restart({ delayMs: 10_000, force: true });
        // Non-force request with shorter delay — must NOT downgrade force
        const second = scheduleGatewaySigusr1Restart({ delayMs: 100 });
        // Should coalesce (not reschedule) since it would downgrade force
        expect(second.coalesced).toBe(true);
        // Fire the original force timer
        await vi.advanceTimersByTimeAsync(10_000);
        // Force skips deferral — should emit immediately
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("does not delay a pending restart when force request arrives with longer delayMs", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 100 }); // fires at 100ms
        scheduleGatewaySigusr1Restart({ delayMs: 5_000, force: true }); // later, but force
        // Must still emit at <= 100ms (preserves the earlier pending time)
        await vi.advanceTimersByTimeAsync(100);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 immediately when force is true even if pending", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => 5); // always pending
        scheduleGatewaySigusr1Restart({ delayMs: 0, force: true });

        // Fire initial timeout — force skips deferral entirely
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });

    it("emits SIGUSR1 if deferral check throws", async () => {
      const emitSpy = vi.spyOn(process, "emit");
      const handler = () => {};
      process.on("SIGUSR1", handler);
      try {
        setPreRestartDeferralCheck(() => {
          throw new Error("boom");
        });
        scheduleGatewaySigusr1Restart({ delayMs: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(emitSpy).toHaveBeenCalledWith("SIGUSR1");
      } finally {
        process.removeListener("SIGUSR1", handler);
      }
    });
  });

  describe("tailnet address detection", () => {
    it("detects tailscale IPv4 and IPv6 addresses", () => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(
        makeNetworkInterfacesSnapshot({
          lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          utun9: [
            { address: "100.123.224.76", family: "IPv4" },
            { address: "fd7a:115c:a1e0::8801:e04c", family: "IPv6" },
          ],
        }),
      );

      const out = listTailnetAddresses();
      expect(out.ipv4).toEqual(["100.123.224.76"]);
      expect(out.ipv6).toEqual(["fd7a:115c:a1e0::8801:e04c"]);
    });
  });
});

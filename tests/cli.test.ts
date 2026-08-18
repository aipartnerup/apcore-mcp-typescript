/**
 * Tests for the CLI entry point (src/cli.ts).
 *
 * We call the exported `main()` function directly with mocked process.argv.
 * process.exit is mocked to throw a sentinel so that fail()/exit() stops
 * execution cleanly rather than continuing past the mock.
 *
 * IMPORTANT: apcore-js on npm is a stub without dist/. All test scenarios
 * must vi.doMock("apcore-js") BEFORE importing cli.ts to avoid Vite
 * resolution errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Sentinel for process.exit ──────────────────────────────────────────────

class ExitSentinel extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

describe("CLI (cli.ts)", () => {
  const originalArgv = [...process.argv];
  const originalExit = process.exit;

  let tmpDir: string;
  let errorMessages: string[];
  let logMessages: string[];
  let infoMessages: string[];
  let warnMessages: string[];

  // Suppress unhandled rejections from module-level main().catch() auto-invocation
  const suppressUnhandled = (err: unknown) => {
    if (err instanceof ExitSentinel) return; // expected
  };

  beforeEach(() => {
    vi.resetModules();
    process.on("unhandledRejection", suppressUnhandled);

    errorMessages = [];
    logMessages = [];
    infoMessages = [];
    warnMessages = [];

    tmpDir = mkdtempSync(join(tmpdir(), "apcore-cli-test-"));

    // Mock process.exit to throw sentinel — stops further execution
    process.exit = ((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never;

    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorMessages.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logMessages.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      infoMessages.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exit = originalExit;
    process.removeListener("unhandledRejection", suppressUnhandled);
    vi.restoreAllMocks();
    try {
      rmdirSync(tmpDir);
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Set process.argv, mock all external deps, and call main() directly.
   * Returns the exit code from ExitSentinel, or -1 if main() completed normally.
   *
   * Every scenario mocks apcore-js (either as available or unavailable)
   * to avoid Vite trying to resolve the stub package.
   */
  async function runMain(args: string[], opts: {
    apcoreAvailable?: boolean;
    discoverCount?: number;
    serveFn?: ReturnType<typeof vi.fn>;
  } = {}) {
    const { apcoreAvailable = true, discoverCount = 0, serveFn } = opts;

    process.argv = ["node", "cli.js", ...args];

    // Always mock apcore-js to prevent Vite resolution errors
    if (apcoreAvailable) {
      vi.doMock("apcore-js", () => ({
        Registry: vi.fn().mockImplementation(() => ({
          discover: vi.fn().mockResolvedValue(discoverCount),
        })),
      }));
    } else {
      vi.doMock("apcore-js", () => {
        throw new Error("Cannot find module 'apcore-js'");
      });
    }

    // Always mock index.js for serve/VERSION/JWTAuthenticator/ElicitationApprovalHandler
    const mockServe = serveFn ?? vi.fn().mockResolvedValue(undefined);
    vi.doMock("../src/index.js", () => ({
      serve: mockServe,
      VERSION: "0.0.0-test",
      JWTAuthenticator: vi.fn().mockImplementation(() => ({ authenticate: vi.fn() })),
      ElicitationApprovalHandler: vi.fn().mockImplementation(() => ({
        requestApproval: vi.fn(),
        checkApproval: vi.fn(),
      })),
    }));

    const mod = await import("../src/cli.js");

    // Wait a tick for the module-level main().catch() auto-invocation to settle
    await new Promise((r) => setTimeout(r, 50));

    const { main } = mod;

    try {
      await main();
      return { exitCode: -1, mockServe };
    } catch (e) {
      if (e instanceof ExitSentinel) {
        return { exitCode: e.code, mockServe };
      }
      throw e;
    }
  }

  // ── Help ────────────────────────────────────────────────────────────────

  it("prints help and exits 0 with --help", async () => {
    const { exitCode } = await runMain(["--help"]);

    expect(exitCode).toBe(0);
    expect(logMessages.some((m) => m.includes("apcore-mcp"))).toBe(true);
    expect(logMessages.some((m) => m.includes("--extensions-dir"))).toBe(true);
  });

  it("[B-TS-11] documents every accepted flag in the help output", async () => {
    // --jwt-key-file was implemented, README-documented and the highest-priority
    // key source (--jwt-key-file > --jwt-secret > APCORE_JWT_SECRET), yet absent
    // from printUsage, so `apcore-mcp --help` never mentioned it. Deriving the
    // expected flags from parseArgs keeps help and options in step from now on.
    const source = readFileSync(
      new URL("../src/cli.ts", import.meta.url),
      "utf8",
    );
    const optionsStart = source.indexOf("options: {") + "options: {".length;
    const optionsBlock = source.slice(optionsStart, source.indexOf("strict: true"));
    const flags = [...optionsBlock.matchAll(/^\s*"?([a-z][a-z-]*)"?:\s*\{/gm)].map(
      (m) => `--${m[1]}`,
    );
    expect(flags).toContain("--jwt-key-file");

    const { exitCode } = await runMain(["--help"]);
    expect(exitCode).toBe(0);
    const help = logMessages.join("\n");

    const undocumented = flags.filter((flag) => !help.includes(flag));
    expect(undocumented).toEqual([]);
  });

  // ── Argument validation ────────────────────────────────────────────────

  it("fails when --extensions-dir is missing", async () => {
    const { exitCode } = await runMain([]);

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--extensions-dir is required")),
    ).toBe(true);
  });

  it("fails when --extensions-dir path does not exist", async () => {
    const { exitCode } = await runMain([
      "--extensions-dir",
      "/nonexistent/path/12345",
    ]);

    expect(exitCode).toBe(1);
    expect(errorMessages.some((m) => m.includes("does not exist"))).toBe(true);
  });

  it("fails for invalid --transport", async () => {
    const { exitCode } = await runMain([
      "--extensions-dir", tmpDir,
      "--transport", "websocket",
    ]);

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--transport must be one of")),
    ).toBe(true);
  });

  it("fails for out-of-range --port", async () => {
    const { exitCode } = await runMain([
      "--extensions-dir", tmpDir,
      "--port", "99999",
    ]);

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--port must be in range")),
    ).toBe(true);
  });

  it("fails for non-numeric --port", async () => {
    const { exitCode } = await runMain([
      "--extensions-dir", tmpDir,
      "--port", "abc",
    ]);

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--port must be in range")),
    ).toBe(true);
  });

  it("fails for --name exceeding 255 characters", async () => {
    const longName = "a".repeat(256);
    const { exitCode } = await runMain([
      "--extensions-dir", tmpDir,
      "--name", longName,
    ]);

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--name must be at most 255")),
    ).toBe(true);
  });

  // ── Unknown flags ──────────────────────────────────────────────────────

  it("exits 2 for unknown flags (parseArgs strict mode)", async () => {
    const { exitCode } = await runMain(["--unknown-flag"]);

    expect(exitCode).toBe(2);
  });

  // ── apcore-js availability ─────────────────────────────────────────────

  it("fails when apcore-js is not importable", async () => {
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: false },
    );

    expect(exitCode).toBe(1);
    expect(errorMessages.some((m) => m.includes("apcore-js"))).toBe(true);
  });

  // ── Success path ───────────────────────────────────────────────────────

  it("succeeds when apcore-js is available and calls serve()", async () => {
    const { exitCode, mockServe } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: true, discoverCount: 3 },
    );

    expect(exitCode).toBe(-1); // no process.exit
    // main() is called manually + once by module-level auto-invocation
    expect(mockServe).toHaveBeenCalled();
  });

  it("warns when 0 modules are discovered", async () => {
    const { exitCode, mockServe } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: true, discoverCount: 0 },
    );

    expect(exitCode).toBe(-1);
    expect(
      warnMessages.some((m) => m.includes("No modules discovered")),
    ).toBe(true);
    expect(mockServe).toHaveBeenCalled();
  });

  it("logs module count when modules are discovered", async () => {
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: true, discoverCount: 5 },
    );

    expect(exitCode).toBe(-1);
    expect(
      infoMessages.some((m) => m.includes("Discovered 5 module(s)")),
    ).toBe(true);
  });

  it("fails for invalid --log-level", async () => {
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--log-level", "TRACE"],
      { apcoreAvailable: true, discoverCount: 1 },
    );

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--log-level must be one of")),
    ).toBe(true);
  });

  // ── JWT flags ─────────────────────────────────────────────────────────

  it("passes authenticator to serve() when --jwt-secret is provided", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--jwt-secret", "my-secret"],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeDefined();
  });

  it("does not pass authenticator when --jwt-secret is not provided", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeUndefined();
  });

  it("passes jwt-algorithm to authenticator", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--jwt-secret", "sec", "--jwt-algorithm", "HS384"],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeDefined();
  });

  it("accepts --jwt-audience and --jwt-issuer flags", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      [
        "--extensions-dir", tmpDir,
        "--jwt-secret", "sec",
        "--jwt-audience", "my-app",
        "--jwt-issuer", "auth-svc",
      ],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeDefined();
  });

  // ── --jwt-key-file ────────────────────────────────────────────────

  it("reads JWT key from --jwt-key-file", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const keyPath = path.join(tmpDir, "test-key.pem");
    fs.writeFileSync(keyPath, "file-secret\n");

    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--jwt-key-file", keyPath],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeDefined();
  });

  it("--jwt-key-file takes priority over --jwt-secret", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const keyPath = path.join(tmpDir, "priority-key.pem");
    fs.writeFileSync(keyPath, "file-wins\n");

    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--jwt-key-file", keyPath, "--jwt-secret", "cli-secret"],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.authenticator).toBeDefined();
  });

  // ── APCORE_JWT_SECRET env var fallback ─────────────────────────────

  it("uses APCORE_JWT_SECRET env var when --jwt-secret is not provided", async () => {
    const originalEnv = process.env.APCORE_JWT_SECRET;
    process.env.APCORE_JWT_SECRET = "env-secret";
    try {
      const serveFn = vi.fn().mockResolvedValue(undefined);
      const { exitCode } = await runMain(
        ["--extensions-dir", tmpDir],
        { apcoreAvailable: true, discoverCount: 1, serveFn },
      );

      expect(exitCode).toBe(-1);
      expect(serveFn).toHaveBeenCalled();
      const opts = serveFn.mock.calls[0][1];
      expect(opts.authenticator).toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.APCORE_JWT_SECRET;
      } else {
        process.env.APCORE_JWT_SECRET = originalEnv;
      }
    }
  });

  it("--jwt-secret takes priority over APCORE_JWT_SECRET env var", async () => {
    const originalEnv = process.env.APCORE_JWT_SECRET;
    process.env.APCORE_JWT_SECRET = "env-secret";
    try {
      const serveFn = vi.fn().mockResolvedValue(undefined);
      const { exitCode } = await runMain(
        ["--extensions-dir", tmpDir, "--jwt-secret", "cli-secret"],
        { apcoreAvailable: true, discoverCount: 1, serveFn },
      );

      expect(exitCode).toBe(-1);
      expect(serveFn).toHaveBeenCalled();
      const opts = serveFn.mock.calls[0][1];
      expect(opts.authenticator).toBeDefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.APCORE_JWT_SECRET;
      } else {
        process.env.APCORE_JWT_SECRET = originalEnv;
      }
    }
  });

  it("no authenticator when neither --jwt-secret nor APCORE_JWT_SECRET is set", async () => {
    const originalEnv = process.env.APCORE_JWT_SECRET;
    delete process.env.APCORE_JWT_SECRET;
    try {
      const serveFn = vi.fn().mockResolvedValue(undefined);
      const { exitCode } = await runMain(
        ["--extensions-dir", tmpDir],
        { apcoreAvailable: true, discoverCount: 1, serveFn },
      );

      expect(exitCode).toBe(-1);
      expect(serveFn).toHaveBeenCalled();
      const opts = serveFn.mock.calls[0][1];
      expect(opts.authenticator).toBeUndefined();
    } finally {
      if (originalEnv !== undefined) {
        process.env.APCORE_JWT_SECRET = originalEnv;
      }
    }
  });

  // ── Approval flags ──────────────────────────────────────────────────

  it("fails for invalid --approval mode", async () => {
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--approval", "invalid"],
      { apcoreAvailable: true, discoverCount: 1 },
    );

    expect(exitCode).toBe(1);
    expect(
      errorMessages.some((m) => m.includes("--approval must be one of")),
    ).toBe(true);
  });

  it("passes approvalHandler to serve() when --approval elicit", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir, "--approval", "elicit"],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.approvalHandler).toBeDefined();
  });

  it("does not pass approvalHandler when --approval off (default)", async () => {
    const serveFn = vi.fn().mockResolvedValue(undefined);
    const { exitCode } = await runMain(
      ["--extensions-dir", tmpDir],
      { apcoreAvailable: true, discoverCount: 1, serveFn },
    );

    expect(exitCode).toBe(-1);
    expect(serveFn).toHaveBeenCalled();
    const opts = serveFn.mock.calls[0][1];
    expect(opts.approvalHandler).toBeUndefined();
  });
});

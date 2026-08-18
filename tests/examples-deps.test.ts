/**
 * [B-TS-2] Every bare module the examples import must be declared and installed.
 *
 * pnpm isolates transitive dependencies, so apcore-js's own copy of
 * @sinclair/typebox is not reachable from examples/. Nothing else in the suite
 * loads the examples, so an undeclared import there fails only for users
 * following the README — this test closes that gap without booting a server.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const EXAMPLES_DIR = new URL("../examples", import.meta.url).pathname;

/**
 * Resolve `spec` the way `npx tsx examples/...` would.
 *
 * A plain `createRequire(import.meta.url)` inside vitest goes through Vite's
 * resolver, which reaches into pnpm's .pnpm store and finds packages that real
 * Node cannot see — exactly the failure mode under test. Shelling out is what
 * makes this assertion meaningful, and NODE_PATH must be cleared because vitest
 * points it at `.pnpm/node_modules`, which would leak the same false positive
 * into the child process.
 */
function resolvesInNode(spec: string, fromFile: string): boolean {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'require("module").createRequire(process.argv[1]).resolve(process.argv[2])',
      fromFile,
      spec,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );
  return result.status === 0;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

function bareSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) {
      continue;
    }
    found.add(spec);
  }
  return [...found];
}

describe("examples dependency declarations", () => {
  const files = walk(EXAMPLES_DIR);

  it("finds example sources to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports only resolvable packages", (file) => {
    const specs = bareSpecifiers(readFileSync(file, "utf8"));
    for (const spec of specs) {
      // Own package name — examples import the built entry point by name.
      if (spec === "apcore-mcp" || spec.startsWith("apcore-mcp/")) continue;
      expect(resolvesInNode(spec, file), `${spec} (in ${file})`).toBe(true);
    }
  });

  it("declares the tsx runner the README tells users to invoke", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.["tsx"]).toBeTypeOf("string");
  });
});

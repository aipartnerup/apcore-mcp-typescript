/**
 * [B-TS-3] Type-level regression: a real apcore-js `Registry` must be assignable
 * to this package's public entry points without a cast.
 *
 * The defect this pins is compile-time only — TypeScript types are erased, so no
 * runtime assertion can catch it. `pnpm typecheck` is what enforces this file:
 * tsconfig.typecheck.json includes tests/, so a structural drift between
 * src/types.ts and apcore-js (e.g. `cacheKeyFields: string[]` against apcore-js's
 * `readonly string[]`) fails the build here instead of only in user code.
 */

import { describe, it, expect } from "vitest";
import { Registry } from "apcore-js";
import { APCoreMCP, toOpenaiTools, serve } from "../../src/index.js";
import type { RegistryOrExecutor } from "../../src/types.js";

describe("apcore-js Registry variance", () => {
  it("is accepted by RegistryOrExecutor, APCoreMCP and toOpenaiTools", () => {
    const registry = new Registry();

    const asBackend: RegistryOrExecutor = registry;
    expect(asBackend).toBe(registry);

    expect(new APCoreMCP(registry)).toBeDefined();
    expect(toOpenaiTools(registry)).toEqual([]);
  });

  it("is accepted by serve()", () => {
    // Referenced for its parameter type only — actually awaiting serve() would
    // start a stdio transport and block the test run.
    const boundServe: (r: Registry) => Promise<void> = (r) =>
      serve(r, { transport: "stdio" });
    expect(typeof boundServe).toBe("function");
  });
});

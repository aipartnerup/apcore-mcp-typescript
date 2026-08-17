/**
 * Locating the shared cross-language conformance fixtures.
 *
 * The fixtures live in the apcore-mcp spec repository rather than here,
 * because all three bridges have to drive the same bytes for the comparison
 * to mean anything. This module is the single place that knows how to find
 * them, and — more importantly — the single place that decides what a
 * *missing* fixture means.
 *
 * Every conformance suite used to answer that question with `it.skip`. That is
 * the right answer for a contributor who has not checked the spec repo out. It
 * was the wrong answer in CI, where no workflow checked the spec repo out at
 * all: the suite reported success while 23 cross-language assertions never
 * ran, and nothing in the output distinguished that from having run them. The
 * answer therefore depends on where we are — skip locally, throw in CI.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

const FIXTURE_SUBPATH = ["apcore-mcp", "conformance", "fixtures"];
const ENV_OVERRIDE = "APCORE_CONFORMANCE_FIXTURES";
const MAX_ASCENT = 4;

/** Return the shared fixtures directory, or `null` when it is not present. */
export function fixturesDir(): string | null {
  const override = process.env[ENV_OVERRIDE];
  if (override) {
    return existsSync(override) && statSync(override).isDirectory() ? override : null;
  }

  // One walk covers both layouts: the sibling checkout developers use
  // (`…/aipartnerup/apcore-mcp`) and CI, where the spec repo is checked out
  // *inside* the workspace (`$GITHUB_WORKSPACE/apcore-mcp`) because
  // `actions/checkout` refuses to place a repository outside it.
  let dir = __dirname;
  for (let i = 0; i <= MAX_ASCENT; i += 1) {
    const candidate = resolve(dir, ...FIXTURE_SUBPATH);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load a conformance fixture by file name.
 *
 * Returns `null` when the fixtures are simply absent locally, so the caller
 * can `it.skip`. Throws in CI, where absence means the suite proves nothing.
 */
export function loadFixture<T>(name: string): T | null {
  const dir = fixturesDir();
  if (dir) {
    const path = resolve(dir, name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as T;
  }

  const detail =
    `conformance fixture "${name}" not found: checked $${ENV_OVERRIDE} and ` +
    `every ancestor of ${__dirname} for ${FIXTURE_SUBPATH.join("/")}`;

  if (process.env.CI) {
    throw new Error(
      `${detail}. In CI this is a failure rather than a skip: the ` +
        "cross-language conformance suite exists to catch divergence between " +
        "the three bridges, and skipping it silently reports success while " +
        "proving nothing. The workflow must check out aiperceivable/apcore-mcp " +
        "to the `apcore-mcp` path.",
    );
  }
  return null;
}

/** Message for the `it.skip` a caller registers when {@link loadFixture} returns null. */
export function skipMessage(name: string): string {
  return `conformance fixture "${name}" not found — check out aiperceivable/apcore-mcp alongside this repository to run it`;
}

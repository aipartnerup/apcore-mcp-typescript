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

/**
 * Every directory that could hold the shared fixtures, in priority order.
 *
 * `$APCORE_CONFORMANCE_FIXTURES` contributes two candidates, not one: pointing
 * it at the apcore-mcp checkout root is the natural reading of the name, and
 * pointing it at the fixtures directory itself is what the variable literally
 * says. Accepting only the latter — and returning early, so the ancestor walk
 * never ran — is what broke CI: ci.yml set it to `$GITHUB_WORKSPACE/apcore-mcp`,
 * an existing directory with no fixtures in it, and every conformance suite
 * failed with the fixtures sitting one walk away. Resolution is therefore driven
 * by "which directory actually holds this fixture", never by which path looks
 * plausible, and a wrong override degrades to the walk instead of killing it.
 */
function candidateDirs(): string[] {
  const candidates: string[] = [];

  const override = process.env[ENV_OVERRIDE];
  if (override) {
    candidates.push(override, resolve(override, ...FIXTURE_SUBPATH.slice(1)));
  }

  // One walk covers both layouts: the sibling checkout developers use
  // (`…/aipartnerup/apcore-mcp`) and CI, where the spec repo is checked out
  // *inside* the workspace (`$GITHUB_WORKSPACE/apcore-mcp`) because
  // `actions/checkout` refuses to place a repository outside it.
  let dir = __dirname;
  for (let i = 0; i <= MAX_ASCENT; i += 1) {
    candidates.push(resolve(dir, ...FIXTURE_SUBPATH));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return candidates.filter((c) => existsSync(c) && statSync(c).isDirectory());
}

/** Return the shared fixtures directory, or `null` when it is not present. */
export function fixturesDir(): string | null {
  return candidateDirs()[0] ?? null;
}

/**
 * Load a conformance fixture by file name.
 *
 * Returns `null` when the fixtures are simply absent locally, so the caller
 * can `it.skip`. Throws in CI, where absence means the suite proves nothing.
 */
export function loadFixture<T>(name: string): T | null {
  for (const dir of candidateDirs()) {
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

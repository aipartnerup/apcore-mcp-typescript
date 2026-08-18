/**
 * Tests for the conformance fixture locator itself.
 *
 * $APCORE_CONFORMANCE_FIXTURES used to short-circuit resolution: any existing
 * directory was accepted as *the* fixtures directory and the ancestor walk was
 * never tried. ci.yml set it to `$GITHUB_WORKSPACE/apcore-mcp` — the checkout
 * root rather than the fixtures directory inside it — so every conformance
 * suite failed in CI even though the fixtures were sitting one walk away.
 * Pointing the variable at the repo root is the natural reading, so the locator
 * has to survive it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture } from "./conformance-fixtures.js";

const ENV = "APCORE_CONFORMANCE_FIXTURES";
const FIXTURE = "acl_config.json";

/** Locate the shared fixtures without going through the module under test. */
function locateFixtures(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i <= 4; i += 1) {
    const candidate = resolve(dir, "apcore-mcp", "conformance", "fixtures");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const fixturesDir = locateFixtures();
const checkoutRoot = fixturesDir ? resolve(fixturesDir, "..", "..") : null;

describe.skipIf(!fixturesDir)("conformance fixture locator", () => {
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("resolves when the override points at the fixtures directory", () => {
    process.env[ENV] = fixturesDir!;
    expect(loadFixture(FIXTURE)).not.toBeNull();
  });

  it("resolves when the override points at the apcore-mcp checkout root", () => {
    process.env[ENV] = checkoutRoot!;
    expect(loadFixture(FIXTURE)).not.toBeNull();
  });

  it("falls back to the ancestor walk when the override is wrong", () => {
    process.env[ENV] = resolve(checkoutRoot!, "no-such-directory");
    expect(loadFixture(FIXTURE)).not.toBeNull();
  });

  it("resolves with no override at all", () => {
    delete process.env[ENV];
    expect(loadFixture(FIXTURE)).not.toBeNull();
  });
});

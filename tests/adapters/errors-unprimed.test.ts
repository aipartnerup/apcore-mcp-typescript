/**
 * [A-D-EM-5] toMcpErrorAny must not depend on the apcore-js dynamic import
 * having settled.
 *
 * src/adapters/errors.ts kicks off `void _loadApcoreErrorClasses()` without
 * awaiting it, so `_apcoreErrorClasses?.ModuleError` is undefined for every call
 * made before that promise resolves — and permanently if apcore-js cannot be
 * resolved. toMcpError degrades gracefully in that window because it falls back
 * to duck-typing; toMcpErrorAny had no such fallback and returned the
 * GENERAL_INTERNAL_ERROR envelope for genuine ModuleErrors, discarding
 * errorType, details, retryable and aiGuidance.
 *
 * These tests live in their own file because vi.doMock("apcore-js") has to be
 * installed before src/adapters/errors.ts is first imported.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function moduleErrorShaped(): Error {
  return Object.assign(new Error("Module 'image.resize' not found"), {
    code: "MODULE_NOT_FOUND",
    details: { moduleId: "image.resize" },
  });
}

describe("[A-D-EM-5] toMcpErrorAny without apcore-js error classes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("apcore-js");
    vi.resetModules();
  });

  it("duck-types a ModuleError when apcore-js cannot be resolved", async () => {
    vi.doMock("apcore-js", () => {
      throw new Error("Cannot find module 'apcore-js'");
    });

    const { ErrorMapper } = await import("../../src/adapters/errors.js");
    const result = new ErrorMapper().toMcpErrorAny(moduleErrorShaped());

    expect(result.errorType).toBe("MODULE_NOT_FOUND");
    expect(result.message).toBe("Module 'image.resize' not found");
    expect(result.details).toEqual({ moduleId: "image.resize" });
  });

  it("duck-types a ModuleError when apcore-js exports no ModuleError class", async () => {
    // Same observable state as the not-yet-settled window: the cache is loaded
    // but `ModuleError` is undefined, so the instanceof pivot cannot fire.
    vi.doMock("apcore-js", () => ({}));

    const { ErrorMapper } = await import("../../src/adapters/errors.js");
    const result = new ErrorMapper().toMcpErrorAny(moduleErrorShaped());

    expect(result.errorType).toBe("MODULE_NOT_FOUND");
  });

  it("still collapses non-module errors to the canonical envelope", async () => {
    vi.doMock("apcore-js", () => {
      throw new Error("Cannot find module 'apcore-js'");
    });

    const { ErrorMapper } = await import("../../src/adapters/errors.js");
    const mapper = new ErrorMapper();

    const a = mapper.toMcpErrorAny(new TypeError("secret-XYZ"));
    const b = mapper.toMcpErrorAny({ unexpected: "shape" });

    expect(a.errorType).toBe("GENERAL_INTERNAL_ERROR");
    expect(a.message).toBe("Internal error occurred");
    expect(a.details).toBeNull();
    expect(JSON.stringify(a)).not.toContain("secret-XYZ");
    expect(b).toEqual(a);
  });
});

import { describe, expect, it } from "vitest";
import {
  isSystemReadModule,
  isSystemControlModule,
  systemResourceUri,
  systemResourceUriTemplate,
  systemResourceAcceptsQueryParam,
  parseSystemResourceUri,
  computeManagementSurfaces,
  SYSTEM_STATIC_RESOURCE_MODULES,
  SYSTEM_TEMPLATE_RESOURCE_MODULES,
} from "../../src/server/system-surface.js";

describe("isSystemReadModule", () => {
  it("is true for system.health.*, system.usage.*, system.manifest.*", () => {
    expect(isSystemReadModule("system.health.summary")).toBe(true);
    expect(isSystemReadModule("system.health.module")).toBe(true);
    expect(isSystemReadModule("system.usage.summary")).toBe(true);
    expect(isSystemReadModule("system.usage.module")).toBe(true);
    expect(isSystemReadModule("system.manifest.full")).toBe(true);
    expect(isSystemReadModule("system.manifest.module")).toBe(true);
  });

  it("is false for system.control.* write modules", () => {
    expect(isSystemReadModule("system.control.update_config")).toBe(false);
    expect(isSystemReadModule("system.control.reload_module")).toBe(false);
    expect(isSystemReadModule("system.control.toggle_feature")).toBe(false);
  });

  it("is false for non-system modules", () => {
    expect(isSystemReadModule("text.analyze")).toBe(false);
    expect(isSystemReadModule("systemx.health.summary")).toBe(false);
  });

  it("leaves an unrecognised read-only system.* id a tool rather than vanishing it", () => {
    // registerResourceHandlers builds resources from the six canonical ids, so
    // a bare prefix match here would remove such a module from `tools/list`
    // while giving it no resource either — it would disappear from both
    // discovery surfaces at once. A seventh module added by a future
    // apcore-js, or one a host registered through `registerInternal`, must
    // stay visible as a tool until this adapter learns its resource shape.
    expect(isSystemReadModule("system.health.history")).toBe(false);
    expect(isSystemReadModule("system.usage.trend")).toBe(false);
    expect(isSystemReadModule("system.manifest.diff")).toBe(false);
  });
});

describe("isSystemControlModule", () => {
  it("is true only for system.control.*", () => {
    expect(isSystemControlModule("system.control.update_config")).toBe(true);
    expect(isSystemControlModule("system.health.summary")).toBe(false);
    expect(isSystemControlModule("text.analyze")).toBe(false);
  });
});

describe("systemResourceUri / systemResourceUriTemplate", () => {
  it("builds static resource URIs", () => {
    expect(systemResourceUri("system.health.summary")).toBe("apcore://system.health.summary");
    expect(systemResourceUri("system.usage.summary")).toBe("apcore://system.usage.summary");
    expect(systemResourceUri("system.manifest.full")).toBe("apcore://system.manifest.full");
  });

  it("builds resource templates, with {?period} only where the module accepts it", () => {
    expect(systemResourceUriTemplate("system.health.module")).toBe(
      "apcore://system.health.module/{module_id}",
    );
    expect(systemResourceUriTemplate("system.manifest.module")).toBe(
      "apcore://system.manifest.module/{module_id}",
    );
    expect(systemResourceUriTemplate("system.usage.module")).toBe(
      "apcore://system.usage.module/{module_id}{?period}",
    );
  });

  it("systemResourceAcceptsQueryParam reflects period support", () => {
    expect(systemResourceAcceptsQueryParam("system.usage.summary", "period")).toBe(true);
    expect(systemResourceAcceptsQueryParam("system.usage.module", "period")).toBe(true);
    expect(systemResourceAcceptsQueryParam("system.health.summary", "period")).toBe(false);
    expect(systemResourceAcceptsQueryParam("system.manifest.full", "period")).toBe(false);
  });
});

describe("parseSystemResourceUri", () => {
  it("parses a static resource URI with no params", () => {
    const parsed = parseSystemResourceUri("apcore://system.health.summary");
    expect(parsed).toEqual({ moduleId: "system.health.summary", args: {} });
  });

  it("parses a template URI with a module_id path segment", () => {
    const parsed = parseSystemResourceUri("apcore://system.health.module/some.module.id");
    expect(parsed).toEqual({
      moduleId: "system.health.module",
      args: { module_id: "some.module.id" },
    });
  });

  it("parses a query parameter", () => {
    const parsed = parseSystemResourceUri("apcore://system.usage.summary?period=24h");
    expect(parsed).toEqual({ moduleId: "system.usage.summary", args: { period: "24h" } });
  });

  it("parses both a path segment and a query parameter together", () => {
    const parsed = parseSystemResourceUri(
      "apcore://system.usage.module/some.mod?period=7d",
    );
    expect(parsed).toEqual({
      moduleId: "system.usage.module",
      args: { module_id: "some.mod", period: "7d" },
    });
  });

  it("returns null for a non-apcore URI scheme", () => {
    expect(parseSystemResourceUri("docs://some.module")).toBeNull();
  });

  it("returns null for a malformed URI", () => {
    expect(parseSystemResourceUri("not a uri at all")).toBeNull();
  });
});

describe("computeManagementSurfaces", () => {
  function registryOf(ids: string[]) {
    return { list: () => ids };
  }

  it("all false for an empty registry", () => {
    expect(computeManagementSurfaces(registryOf([]))).toEqual({
      health: false,
      usage: false,
      manifest: false,
      control: false,
    });
  });

  it("reflects each surface independently", () => {
    expect(computeManagementSurfaces(registryOf(["system.health.summary", "text.analyze"]))).toEqual({
      health: true,
      usage: false,
      manifest: false,
      control: false,
    });
    expect(
      computeManagementSurfaces(
        registryOf([
          "system.health.summary",
          "system.usage.summary",
          "system.manifest.full",
          "system.control.reload_module",
        ]),
      ),
    ).toEqual({ health: true, usage: true, manifest: true, control: true });
  });
});

describe("canonical module id lists", () => {
  it("static and template lists are disjoint and cover the six read modules", () => {
    const all = [...SYSTEM_STATIC_RESOURCE_MODULES, ...SYSTEM_TEMPLATE_RESOURCE_MODULES];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(
      [
        "system.health.summary",
        "system.usage.summary",
        "system.manifest.full",
        "system.health.module",
        "system.manifest.module",
        "system.usage.module",
      ].sort(),
    );
    for (const id of all) {
      expect(isSystemReadModule(id)).toBe(true);
    }
  });
});

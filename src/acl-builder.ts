/**
 * Build an apcore `ACL` instance from a Config Bus `mcp.acl` section.
 *
 * Config Bus schema (YAML, shared across Python/TS/Rust bridges). The real,
 * registered `system.*` module ids (from `registerSysModules` in
 * apcore-typescript's `src/sys-modules/registration.ts`) are:
 *
 *   system.health.summary     system.manifest.module    system.control.toggle_feature
 *   system.health.module      system.manifest.full      system.control.update_config
 *   system.usage.summary      system.usage.module       system.control.reload_module
 *
 * There is no `sys.*` namespace — a rule copied with a `sys.*` target never
 * matches anything, and ACL evaluation is first-match-wins (PROTOCOL_SPEC
 * §6.3), so the miss is silent rather than an error (aiperceivable/apcore-mcp#14).
 *
 * Two mechanism facts the template below depends on:
 * - Calls arriving over MCP always have `caller_id == null`, which ACL
 *   evaluation normalises to `@external`. You CANNOT separate "console" from
 *   "agent" using `callers` alone.
 * - That separation is done by `conditions` reading the authenticated
 *   identity: `identity_types` and `roles` are populated from JWT claims by
 *   `auth/jwt.ts` (`sub` → `Identity.id`, `type` → `Identity.type`, `roles` →
 *   `Identity.roles`).
 *
 * ```yaml
 * mcp:
 *   acl:
 *     default_effect: deny
 *     rules:
 *       # Rule 1 — read-only management surface.
 *       # MUST precede the catch-all deny: evaluation is first-match-wins.
 *       - callers: ["@external"]
 *         targets: ["system.health.*", "system.usage.*", "system.manifest.*"]
 *         effect: allow
 *         conditions:
 *           identity_types: ["human"]
 *           roles: ["apcore.admin"]
 *         description: "Console read access to the management surface"
 *
 *       # Rule 2 — administration. ACL allow is not execution:
 *       # system.control.* declares requiresApproval=true and still passes
 *       # the approval gate.
 *       - callers: ["@external"]
 *         targets: ["system.control.*"]
 *         effect: allow
 *         conditions:
 *           identity_types: ["human"]
 *           roles: ["apcore.admin"]
 *         description: "Administration; requires_approval still applies"
 *
 *       # Rule 3 — catch-all deny. MUST be last.
 *       # Agent identities, anonymous callers and insufficient roles land here.
 *       - callers: ["@external"]
 *         targets: ["system.*"]
 *         effect: deny
 *         description: "Block all other access to system modules"
 * ```
 *
 * **Enabling `sys_modules.enabled` without an ACL means no authorization.**
 * `ACL.discover()` returns `null` when the resolved `acl/` path does not
 * exist — "missing path = no enforcement, identical to a project that never
 * configured an ACL" (apcore-typescript `src/acl.ts`). That default is
 * deliberate and unchanged; enabling system modules with no `acl/` directory
 * on disk means the entire management surface (including `system.control.*`)
 * is reachable by any caller who can reach the MCP transport.
 *
 * A rule may also carry `approval` (apcore 0.28.0, argument-scoped approval,
 * PROTOCOL_SPEC §6.1.6). Accepted values are the same closed set apcore-js
 * itself accepts — `"required"` and `"not_required"` (`ACLApproval` in
 * apcore-js `src/acl.ts`) — and the value is passed through verbatim;
 * `new ACL()` performs the authoritative validation (e.g. rejecting
 * `approval: "required"` paired with `effect: "deny"`). This bridge
 * deliberately does not narrow that set: an earlier version accepted only
 * `"required"`, which made a rule that loads fine from apcore's own `acl/`
 * directory fail at startup when carried through the Config Bus instead.
 *
 * Mirrors the Python `acl_builder.build_acl_from_config` contract. Invalid
 * entries throw so misconfiguration fails loudly at startup.
 */

const ALLOWED_EFFECTS = new Set(["allow", "deny"]);
const ALLOWED_RULE_KEYS = new Set([
  "callers",
  "targets",
  "effect",
  "description",
  "conditions",
  "approval",
]);
/**
 * The closed set apcore-js's own `ACLApproval` accepts (PROTOCOL_SPEC
 * §6.1.6). `"not_required"` is both spec-sanctioned and the default, so it
 * is accepted here rather than rejected as a redundant spelling — see the
 * module doc comment.
 */
const ALLOWED_APPROVALS = new Set(["required", "not_required"]);

export interface AclConfigRule {
  callers: string[];
  targets: string[];
  effect: string;
  description?: string;
  conditions?: Record<string, unknown> | null;
  /**
   * Argument-scoped approval (apcore 0.28.0, PROTOCOL_SPEC §6.1.6).
   * `"required"` or `"not_required"` — the same closed set apcore-js
   * accepts; omitting the field means `"not_required"`. `new ACL()` is the
   * authoritative validator.
   */
  approval?: string;
}

export interface AclConfigSection {
  default_effect?: string;
  rules?: AclConfigRule[];
}

/**
 * Construct an apcore `ACL` from a Config Bus `mcp.acl` mapping.
 *
 * Returns `null` when `aclConfig` is falsy (no ACL section configured).
 * Throws on malformed entries.
 */
export async function buildAclFromConfig(
  aclConfig: unknown,
): Promise<unknown | null> {
  if (aclConfig === null || aclConfig === undefined) return null;
  if (typeof aclConfig !== "object" || Array.isArray(aclConfig)) {
    throw new Error(
      `mcp.acl must be a mapping with 'rules' and optional 'default_effect', ` +
        `got ${Array.isArray(aclConfig) ? "array" : typeof aclConfig}`,
    );
  }
  const cfg = aclConfig as Record<string, unknown>;
  const rulesRaw = cfg.rules;
  // Validate rules type up-front — even for empty configs — to keep errors
  // visible at startup rather than silently returning null.
  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
    throw new Error(`mcp.acl.rules must be a list, got ${typeof rulesRaw}`);
  }
  const hasRules = Array.isArray(rulesRaw) && rulesRaw.length > 0;
  const hasDefault = cfg.default_effect !== undefined;
  if (!hasRules && !hasDefault) {
    return null; // Empty config section — treat as no ACL
  }

  let apcore: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apcore = (await import("apcore-js")) as any;
  } catch (err) {
    throw new Error(
      `Config Bus 'mcp.acl' requires apcore-js>=0.18 with ACL support: ${
        (err as Error).message
      }`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ACL = (apcore.ACL ?? (apcore as any).default?.ACL) as
    | {
        new (
          rules: AclConfigRule[],
          defaultEffect?: string,
        ): unknown;
      }
    | undefined;
  if (!ACL) {
    throw new Error("apcore-js does not export ACL");
  }

  const defaultEffect = (cfg.default_effect ?? "deny") as string;
  if (!ALLOWED_EFFECTS.has(defaultEffect)) {
    throw new Error(
      `mcp.acl.default_effect must be 'allow' or 'deny', got '${defaultEffect}'`,
    );
  }

  const rawRules = (rulesRaw ?? []) as unknown[];

  const rules: AclConfigRule[] = [];
  for (let idx = 0; idx < rawRules.length; idx += 1) {
    const entry = rawRules[idx];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `mcp.acl.rules[${idx}] must be an object, got ${
          Array.isArray(entry) ? "array" : typeof entry
        }`,
      );
    }
    const rec = entry as Record<string, unknown>;
    const extra = Object.keys(rec).filter((k) => !ALLOWED_RULE_KEYS.has(k));
    if (extra.length) {
      throw new Error(
        `mcp.acl.rules[${idx}] got unexpected keys: ${extra.sort().join(", ")}`,
      );
    }

    const callers = rec.callers;
    const targets = rec.targets;
    const effect = rec.effect;

    if (!Array.isArray(callers) || callers.length === 0) {
      throw new Error(
        `mcp.acl.rules[${idx}] 'callers' must be a non-empty list`,
      );
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error(
        `mcp.acl.rules[${idx}] 'targets' must be a non-empty list`,
      );
    }
    if (typeof effect !== "string" || !ALLOWED_EFFECTS.has(effect)) {
      throw new Error(
        `mcp.acl.rules[${idx}] 'effect' must be 'allow' or 'deny', got '${effect}'`,
      );
    }

    const rule: AclConfigRule = {
      callers: [...(callers as string[])],
      targets: [...(targets as string[])],
      effect: effect as string,
      description: typeof rec.description === "string" ? rec.description : "",
    };
    if (rec.conditions !== undefined && rec.conditions !== null) {
      if (typeof rec.conditions !== "object" || Array.isArray(rec.conditions)) {
        throw new Error(
          `mcp.acl.rules[${idx}] 'conditions' must be an object or null`,
        );
      }
      rule.conditions = rec.conditions as Record<string, unknown>;
    }
    if (rec.approval !== undefined && rec.approval !== null) {
      if (typeof rec.approval !== "string" || !ALLOWED_APPROVALS.has(rec.approval)) {
        throw new Error(
          `mcp.acl.rules[${idx}] 'approval' must be 'required' or 'not_required' (or omitted), got '${String(rec.approval)}'`,
        );
      }
      rule.approval = rec.approval;
    }
    rules.push(rule);
  }

  return new ACL(rules, defaultEffect);
}

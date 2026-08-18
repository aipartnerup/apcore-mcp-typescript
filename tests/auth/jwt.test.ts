/**
 * Tests for JWTAuthenticator (src/auth/jwt.ts).
 */

import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { JWTAuthenticator } from "../../src/auth/jwt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-secret-key-for-jwt";

// [JWT-1] Authenticator now takes a flat headers map directly; the helper
// just returns the input unchanged for readability of callsites.
function makeReq(headers: Record<string, string> = {}): Record<string, string> {
  return headers;
}

function signToken(
  payload: Record<string, unknown>,
  secret: string = SECRET,
  options?: jwt.SignOptions,
): string {
  return jwt.sign(payload, secret, { algorithm: "HS256", ...options });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JWTAuthenticator", () => {
  // ── Valid tokens ──────────────────────────────────────────────────────

  it("returns Identity for valid token with sub claim", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-123", type: "admin", roles: ["editor", "viewer"] });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-123");
    expect(identity!.type).toBe("admin");
    expect(identity!.roles).toEqual(["editor", "viewer"]);
  });

  it("defaults type to 'user' when not in claims", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-456" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-456");
    expect(identity!.type).toBe("user");
    expect(identity!.roles).toEqual([]);
  });

  // [D11-107] Empty-string type claim falls back to "user", matching
  // Python's `or "user"` semantics. Previously String(claim ?? "user")
  // produced "" for an empty-string claim, diverging from py/rust.
  it("defaults type to 'user' when claim is an empty string", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-empty", type: "" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-empty");
    expect(identity!.type).toBe("user");
  });

  // [D11-107] Non-empty type claim is preserved unchanged.
  it("preserves a non-empty type claim verbatim", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-dev", type: "developer" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-dev");
    expect(identity!.type).toBe("developer");
  });

  it("returns null when sub is missing (matches Python behavior)", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET, requireClaims: [] });
    const token = signToken({ custom_field: "value" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).toBeNull();
  });

  // ── Custom claim mapping ──────────────────────────────────────────────

  it("uses custom claim mapping", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      claimMapping: {
        id: "user_id",
        type: "user_type",
        roles: "permissions",
      },
      requireClaims: [],
    });
    const token = signToken({
      user_id: "custom-789",
      user_type: "service",
      permissions: ["read", "write"],
    });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("custom-789");
    expect(identity!.type).toBe("service");
    expect(identity!.roles).toEqual(["read", "write"]);
  });

  it("handles partial claim mapping (uses defaults for unset)", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      claimMapping: { id: "uid" },
      requireClaims: [],
    });
    const token = signToken({ uid: "partial-user", type: "bot", roles: ["admin"] });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);

    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("partial-user");
    expect(identity!.type).toBe("bot");
    expect(identity!.roles).toEqual(["admin"]);
  });

  // ── Audience and issuer validation ────────────────────────────────────

  it("accepts token with matching audience", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET, audience: "my-app" });
    const token = signToken({ sub: "user-1" }, SECRET, { audience: "my-app" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-1");
  });

  it("rejects token with wrong audience", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET, audience: "my-app" });
    const token = signToken({ sub: "user-1" }, SECRET, { audience: "other-app" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("accepts token with matching issuer", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET, issuer: "auth-service" });
    const token = signToken({ sub: "user-1" }, SECRET, { issuer: "auth-service" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-1");
  });

  it("rejects token with wrong issuer", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET, issuer: "auth-service" });
    const token = signToken({ sub: "user-1" }, SECRET, { issuer: "wrong-issuer" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  // ── Invalid/missing tokens ────────────────────────────────────────────

  it("returns null when no Authorization header", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const req = makeReq({});

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns null for non-Bearer scheme", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const req = makeReq({ authorization: "Basic dXNlcjpwYXNz" });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns null for malformed Bearer header (no token)", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const req = makeReq({ authorization: "Bearer" });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns null for malformed Bearer header (extra parts)", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const req = makeReq({ authorization: "Bearer token extra" });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("tolerates extra whitespace between Bearer prefix and token (D10-004)", async () => {
    // Real-world reverse proxies sometimes emit double-spaces; Python
    // auth_header[7:].strip() and Rust auth_header[7..].trim() both
    // tolerate this. TS now matches.
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1" }, SECRET);
    const req = makeReq({ authorization: `Bearer  ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity?.id).toBe("user-1");
  });

  it("returns null for expired token", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    // [JWT-3] Authenticator now applies 30s clock-skew leeway. Use a
    // token expired 60s ago so it's past the leeway window.
    const token = signToken({ sub: "user-1" }, SECRET, { expiresIn: -60 });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns null for invalid signature (wrong secret)", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1" }, "wrong-secret");
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns null for completely invalid token string", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const req = makeReq({ authorization: "Bearer not.a.valid.jwt" });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  // ── Roles handling ────────────────────────────────────────────────────

  it("returns empty roles when roles claim is not an array", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1", roles: "admin" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.roles).toEqual([]);
  });

  it("converts numeric roles to strings", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1", roles: [1, 2, 3] });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.roles).toEqual(["1", "2", "3"]);
  });

  // ── Case insensitivity ────────────────────────────────────────────────

  it("handles case-insensitive 'bearer' prefix", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1" });
    const req = makeReq({ authorization: `BEARER ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-1");
  });

  // ── attrs claim extraction ──────────────────────────────────────────

  it("extracts attrs from payload using claimMapping.attrs", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      claimMapping: { attrs: ["email", "org"] },
    });
    const token = signToken({ sub: "user-1", email: "a@b.com", org: "acme" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.attrs).toEqual({ email: "a@b.com", org: "acme" });
  });

  it("skips missing attrs claims", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      claimMapping: { attrs: ["email", "missing_claim"] },
    });
    const token = signToken({ sub: "user-1", email: "a@b.com" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.attrs).toEqual({ email: "a@b.com" });
  });

  it("returns empty attrs when no attrs mapping configured", async () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    const token = signToken({ sub: "user-1", email: "a@b.com" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.attrs).toEqual({});
  });

  // ── requireClaims validation ────────────────────────────────────────

  it("returns null when required claim is missing", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      requireClaims: ["sub", "email"],
    });
    const token = signToken({ sub: "user-1" }); // missing "email"
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("returns identity when all required claims are present", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      requireClaims: ["sub", "email"],
    });
    const token = signToken({ sub: "user-1", email: "a@b.com" });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-1");
  });

  it("[A-D-JWT-3] returns null when a required claim is present but null", async () => {
    // PyJWT's `require` option validates with `payload.get(claim) is None`, so
    // Python rejects {"org_id": null}. A key-presence test (`claim in claims`)
    // accepted it and authenticated the caller — fail-open against the reference
    // implementation.
    const auth = new JWTAuthenticator({
      secret: SECRET,
      requireClaims: ["sub", "org_id"],
    });
    const token = signToken({ sub: "user-1", org_id: null });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("[A-D-JWT-3] accepts a required claim carrying a falsy but non-null value", async () => {
    // Only null/undefined are rejected: 0, "" and false are present values and
    // PyJWT accepts them too.
    const auth = new JWTAuthenticator({
      secret: SECRET,
      requireClaims: ["sub", "seat_count", "label", "active"],
    });
    const token = signToken({
      sub: "user-1",
      seat_count: 0,
      label: "",
      active: false,
    });
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-1");
  });

  it("returns null when requireClaims is empty and id claim is missing", async () => {
    const auth = new JWTAuthenticator({
      secret: SECRET,
      requireClaims: [],
    });
    const token = signToken({ custom: "value" }); // no sub claim
    const req = makeReq({ authorization: `Bearer ${token}` });

    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  // ── requireAuth getter ──────────────────────────────────────────────

  it("requireAuth defaults to true", () => {
    const auth = new JWTAuthenticator({ secret: SECRET });
    expect(auth.requireAuth).toBe(true);
  });

  it("requireAuth reflects constructor option", () => {
    const auth = new JWTAuthenticator({ secret: SECRET, requireAuth: false });
    expect(auth.requireAuth).toBe(false);
  });

  // ── D10-008: key validation at construction time removed ────────────

  it("D10-008: constructs without throwing when no key provided", () => {
    // Previously threw: "JWTAuthenticator requires a 'key' (or deprecated 'secret') option"
    // Now: construction succeeds; authenticate() returns null for missing/invalid tokens.
    expect(() => new JWTAuthenticator({})).not.toThrow();
  });

  it("D10-008: authenticate() returns null when constructed with no key", async () => {
    const auth = new JWTAuthenticator({});
    const req = makeReq({ authorization: `Bearer sometoken` });
    const identity = await auth.authenticate(req);
    expect(identity).toBeNull();
  });

  it("D10-008: authenticate() works normally when constructed with a valid key", async () => {
    const auth = new JWTAuthenticator({ key: SECRET });
    const token = signToken({ sub: "user-123" });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const identity = await auth.authenticate(req);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user-123");
  });
});

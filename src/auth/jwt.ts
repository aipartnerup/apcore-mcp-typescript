/**
 * JWT Authenticator — verifies Bearer tokens and maps claims to Identity.
 *
 * Mirrors the Python `JWTAuthenticator` from apcore-mcp-python.
 */

import jwt from "jsonwebtoken";
import { createIdentity, type Identity } from "apcore-js";
import type { Authenticator } from "./types.js";

/** Mapping from JWT claims to Identity fields. */
export interface ClaimMapping {
  /** JWT claim for Identity.id. Default: "sub" */
  id?: string;
  /** JWT claim for Identity.type. Default: "type" */
  type?: string;
  /** JWT claim for Identity.roles. Default: "roles" */
  roles?: string;
  /** Extra claims to copy into Identity.attrs. */
  attrs?: string[];
}

/** Options for constructing a JWTAuthenticator. */
export interface JWTAuthenticatorOptions {
  /** Secret key (symmetric) or public key (asymmetric) for token verification. */
  key?: string;
  /**
   * @deprecated Use `key` instead. Kept for backward compatibility.
   */
  secret?: string;
  /** Allowed algorithms. Default: ["HS256"] */
  algorithms?: jwt.Algorithm[];
  /** Expected audience claim. */
  audience?: string;
  /** Expected issuer claim. */
  issuer?: string;
  /** Custom claim-to-Identity field mapping. */
  claimMapping?: ClaimMapping;
  /** Claims that must be present in the token. Default: ["sub"] */
  requireClaims?: string[];
  /** If true (default), unauthenticated requests are rejected. If false, they proceed without identity. */
  requireAuth?: boolean;
}

/**
 * Authenticator that verifies JWT Bearer tokens from the Authorization header.
 *
 * Returns an Identity on success, or `null` if:
 * - No Authorization header is present
 * - The header is not a valid "Bearer <token>" format
 * - The token fails verification (expired, wrong signature, etc.)
 */
export class JWTAuthenticator implements Authenticator {
  private readonly _secret: string;
  private readonly _algorithms: jwt.Algorithm[];
  private readonly _audience?: string;
  private readonly _issuer?: string;
  private readonly _claimMapping: Required<Omit<ClaimMapping, "attrs">> & { attrs?: string[] };
  private readonly _requireClaims: string[];
  private readonly _requireAuth: boolean;

  constructor(options: JWTAuthenticatorOptions) {
    const keyValue = options.key ?? options.secret;
    // [D10-008] Do NOT throw at construction time for missing key.
    // Python + Rust don't validate the key at construction; they fail
    // gracefully (return null) when authenticate() is called without a valid key.
    // requireAuth belongs on AuthMiddleware, not on the authenticator itself.
    this._secret = keyValue ?? "";
    this._algorithms = options.algorithms ?? ["HS256"];
    this._audience = options.audience;
    this._issuer = options.issuer;
    this._claimMapping = {
      id: options.claimMapping?.id ?? "sub",
      type: options.claimMapping?.type ?? "type",
      roles: options.claimMapping?.roles ?? "roles",
      attrs: options.claimMapping?.attrs,
    };
    this._requireClaims = options.requireClaims ?? ["sub"];
    this._requireAuth = options.requireAuth ?? true;
  }

  /** Whether unauthenticated requests should be rejected. */
  get requireAuth(): boolean {
    return this._requireAuth;
  }

  async authenticate(headers: Record<string, string>): Promise<Identity | null> {
    const authHeader = headers["authorization"] ?? headers["Authorization"];
    if (!authHeader) return null;

    // Case-insensitive "Bearer " prefix; tolerate extra whitespace between the
    // prefix and the token (real-world reverse proxies and auth headers can
    // emit double spaces). Matches apcore-mcp-python (auth_header[7:].strip())
    // and apcore-mcp-rust (auth_header[7..].trim()) behaviour. See D10-004.
    if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
    const token = authHeader.slice(7).trim();
    if (!token) return null;

    try {
      const verifyOptions: jwt.VerifyOptions = {
        algorithms: this._algorithms,
        // [JWT-3] Spec mandates ~30s clock-skew leeway. jsonwebtoken's
        // default clockTolerance is 0; without this, NTP drift between
        // issuer and server produces spurious 401s on tokens valid
        // within ±30s of expiry/nbf.
        clockTolerance: 30,
      };
      if (this._audience) verifyOptions.audience = this._audience;
      if (this._issuer) verifyOptions.issuer = this._issuer;

      const payload = jwt.verify(token, this._secret, verifyOptions);

      // payload can be string (rare) or JwtPayload object
      if (typeof payload === "string") return null;

      const claims = payload as Record<string, unknown>;

      // Check required claims carry a value.
      // [A-D-JWT-3] A key-presence test accepted `{"org_id": null}`, while
      // PyJWT's `require` option validates with `payload.get(claim) is None`
      // and rejects it. Only null/undefined fail here — 0, "" and false are
      // present values that Python accepts too.
      for (const claim of this._requireClaims) {
        const value = claims[claim];
        if (value === undefined || value === null) return null;
      }

      const rawId = claims[this._claimMapping.id];
      if (rawId === undefined || rawId === null) return null;
      const id = String(rawId);
      // [D11-107] Match Python's `claims.get(...) or "user"` semantics —
      // empty string, null, undefined, or non-string all fall back to "user".
      const rawType = claims[this._claimMapping.type];
      const type =
        typeof rawType === "string" && rawType.length > 0 ? rawType : "user";

      const rawRoles = claims[this._claimMapping.roles];
      const roles = Array.isArray(rawRoles) ? rawRoles.map(String) : [];

      // Extract attrs from payload
      const attrs: Record<string, unknown> = {};
      if (this._claimMapping.attrs) {
        for (const key of this._claimMapping.attrs) {
          if (key in claims) {
            attrs[key] = claims[key];
          }
        }
      }

      return createIdentity(id, type, roles, attrs);
    } catch {
      // Verification failed (expired, invalid signature, etc.)
      return null;
    }
  }
}

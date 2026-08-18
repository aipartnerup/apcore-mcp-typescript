/**
 * Auth hook builder for mcp-embedded-ui explorer integration.
 *
 * Mirrors the Python `_build_auth_hook` pattern from apcore-mcp-python.
 * Bridges the Authenticator interface to mcp-embedded-ui's AuthHook,
 * propagating identity through AsyncLocalStorage for the call chain.
 */

import type { Authenticator } from "./types.js";
import { identityStorage } from "./storage.js";

/**
 * Minimal incoming request shape accepted by the auth hook.
 * Compatible with mcp-embedded-ui's IncomingRequest.
 */
interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Build an auth hook for mcp-embedded-ui that bridges to an Authenticator.
 *
 * The hook:
 * 1. Extracts headers from the incoming request and converts to a flat map
 * 2. Delegates to `authenticator.authenticate()` for token validation
 * 3. Throws on auth failure when auth is required (mcp-embedded-ui catches this
 *    and returns 401); in permissive mode it proceeds with a null identity
 * 4. Wraps `next()` in `identityStorage.run()` so `getCurrentIdentity()` works
 *
 * [A-D-JWT-2] The require-auth policy resolves exactly as it does in
 * `TransportManager._authenticateRequest`: an explicit override wins, then the
 * authenticator's own `requireAuth`, then `true`. The hook previously threw
 * unconditionally, so `new JWTAuthenticator({ requireAuth: false })` had no
 * effect anywhere in the TypeScript SDK while Python (middleware.py:92) and Rust
 * (middleware.rs:194) both honoured it.
 *
 * @param authenticator - An Authenticator instance (e.g. JWTAuthenticator)
 * @param options.requireAuth - Overrides the authenticator's own requireAuth
 * @returns An auth hook function compatible with mcp-embedded-ui's AuthHook type
 */
export function buildExplorerAuthHook(
  authenticator: Authenticator,
  options: { requireAuth?: boolean } = {},
): (req: IncomingRequest, next: () => Promise<Response>) => Promise<Response> {
  return async (req: IncomingRequest, next: () => Promise<Response>) => {
    // Flatten headers to Record<string, string> for the Authenticator interface.
    // Multi-value headers are joined with ", " per HTTP/1.1 convention.
    const headersMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headersMap[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
    const identity = await authenticator.authenticate(headersMap);
    if (!identity) {
      const requireAuth = options.requireAuth ?? authenticator.requireAuth ?? true;
      if (requireAuth) {
        throw new Error("Unauthorized");
      }
    }
    return identityStorage.run(identity, next);
  };
}

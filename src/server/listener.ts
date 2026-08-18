/**
 * RegistryListener - Listens for module registration/unregistration events.
 *
 * Subscribes to a Registry's "register" and "unregister" events to
 * dynamically maintain a map of MCP Tool objects as modules come and go.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { REGISTRY_EVENTS } from "../types.js";
import type { Registry } from "../types.js";
import { MCPServerFactory } from "./factory.js";

export class RegistryListener {
  private readonly _registry: Registry;
  private readonly _factory: MCPServerFactory;
  private readonly _tools: Map<string, Tool>;
  private _active: boolean;

  /**
   * Create a RegistryListener.
   *
   * @param registry - The apcore Registry to listen to
   * @param factory - MCPServerFactory used to build Tool objects from descriptors
   */
  constructor(registry: Registry, factory: MCPServerFactory) {
    this._registry = registry;
    this._factory = factory;
    this._tools = new Map();
    this._active = false;
  }

  /**
   * Get a snapshot of the currently registered tools.
   *
   * Returns a new Map to prevent external mutation of internal state.
   */
  get tools(): Map<string, Tool> {
    return new Map(this._tools);
  }

  /**
   * Start listening for registry events.
   *
   * Subscribes to "register" and "unregister" events on the registry.
   * Idempotent: calling start() when already active is a no-op.
   */
  start(): void {
    if (this._active) {
      return;
    }

    this._active = true;

    this._registry.on(REGISTRY_EVENTS.REGISTER, (...args: unknown[]) => {
      if (!this._active) return;
      const moduleId = args[0] as string;
      this._onRegister(moduleId);
    });

    this._registry.on(REGISTRY_EVENTS.UNREGISTER, (...args: unknown[]) => {
      if (!this._active) return;
      const moduleId = args[0] as string;
      this._onUnregister(moduleId);
    });
  }

  /**
   * Stop listening for registry events.
   *
   * Sets the active flag to false so event callbacks become no-ops.
   */
  stop(): void {
    this._active = false;
  }

  /**
   * Handle a module registration event.
   *
   * Gets the module definition from the registry, builds an MCP Tool,
   * and adds it to the internal tools map.
   *
   * @param moduleId - The ID of the newly registered module
   */
  _onRegister(moduleId: string): void {
    // [D11-001] Mirror Python listener.py:75 and Rust listener.rs:66:
    // guard with _active check so post-stop() invocations are no-ops.
    if (!this._active) return;
    try {
      const descriptor = this._registry.getDefinition(moduleId);
      if (descriptor === null) {
        console.warn(
          `RegistryListener: cannot build tool for "${moduleId}": definition is null`,
        );
        return;
      }

      const tool = this._factory.buildTool(descriptor);
      this._tools.set(moduleId, tool);
      // [A-D-RL-5] stderr, not stdout: the MCP stdio transport frames
      // JSON-RPC on process.stdout and any other writer corrupts it.
      console.error(`RegistryListener: registered tool "${moduleId}"`);
    } catch (error) {
      console.warn(
        `RegistryListener: error building tool for "${moduleId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Handle a module unregistration event.
   *
   * Removes the tool from the internal tools map.
   * - [A-D-011]: gates on `_active` (matches Python+Rust idempotence
   *   contract — direct invocation post-stop() is a no-op).
   * - [A-D-011]: only logs when the tool was actually present.
   *
   * @param moduleId - The ID of the unregistered module
   */
  _onUnregister(moduleId: string): void {
    if (!this._active) return;
    const removed = this._tools.delete(moduleId);
    if (removed) {
      // [A-D-RL-5] stderr, not stdout — see _onRegister.
      console.error(`RegistryListener: unregistered tool "${moduleId}"`);
    }
  }
}

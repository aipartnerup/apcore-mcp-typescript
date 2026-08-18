/**
 * MCPServerFactory - Creates and configures MCP Server instances.
 *
 * Responsible for:
 * - Creating low-level MCP Server instances with capabilities
 * - Building MCP Tool objects from apcore module descriptors
 * - Registering tools/list and tools/call request handlers
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Tool,
  CallToolResult,
  Resource,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

import { SchemaConverter } from "../adapters/schema.js";
import { AnnotationMapper } from "../adapters/annotations.js";
import type { Registry, ModuleDescriptor, JsonSchema } from "../types.js";
import type { ExecutionRouter } from "./router.js";
import type { HandleCallExtra } from "./router.js";
import { buildTraceparent } from "./trace-context.js";
import { APCORE_META_TOOL_PREFIX, type AsyncTaskBridge } from "./async-task-bridge.js";
import { ApprovalBridge } from "./approval-bridge.js";
import {
  isMarkdownAvailable,
  primeMarkdownToolkit,
  renderModuleMarkdownSync,
} from "../markdown.js";

/** Metadata keys for AI intent annotations appended to tool descriptions. */
const AI_INTENT_KEYS = ["x-when-to-use", "x-when-not-to-use", "x-common-mistakes", "x-workflow-hints"] as const;

/** Options for filtering when building tools from a registry. */
export interface BuildToolsOptions {
  tags?: string[] | null;
  prefix?: string | null;
  strict?: boolean;
  registry?: Registry;
}

/** Options for building a single MCP tool. */
export interface BuildToolOptions {
  strict?: boolean;
  registry?: Registry;
}

/** Constructor options for {@link MCPServerFactory}. */
export interface MCPServerFactoryOptions {
  /**
   * When `true`, MCP `Tool.description` is rendered as canonical
   * apcore-toolkit Markdown (title, description, parameters, returns,
   * behavior table, tags, examples) instead of the plain one-line
   * description. LLMs select tools primarily from this string —
   * Markdown packs more decision-relevant signal per token.
   *
   * Requires apcore-toolkit (declared as an optional peer dep).
   * Callers MUST `await MCPServerFactory.prepare()` before invoking
   * `buildTool`/`buildTools` so the toolkit module is primed; without
   * priming, the factory falls back to the plain description with a
   * one-time warning.
   */
  richDescription?: boolean;
}

export class MCPServerFactory {
  private readonly _schemaConverter: SchemaConverter;
  private readonly _annotationMapper: AnnotationMapper;
  private readonly _richDescription: boolean;
  private _warnedToolkitMissing = false;

  constructor(options: MCPServerFactoryOptions = {}) {
    this._schemaConverter = new SchemaConverter();
    this._annotationMapper = new AnnotationMapper();
    
    this._richDescription = options.richDescription ?? false;
  }

  /**
   * Asynchronously prime the apcore-toolkit module so subsequent
   * synchronous `buildTool`/`buildTools` calls can render Markdown
   * descriptions. Safe (and cheap) to call when `richDescription` is
   * disabled — just a no-op probe.
   *
   * Returns `true` when toolkit was loaded successfully, `false` when
   * it isn't installed (apcore-toolkit is an optional peer dep).
   */
  static async prepare(): Promise<boolean> {
    return primeMarkdownToolkit();
  }

  /** Whether this factory renders `Tool.description` as Markdown. */
  get richDescription(): boolean {
    return this._richDescription;
  }

  /**
   * Create a low-level MCP Server instance.
   *
   * @param name - Server name (default: "apcore-mcp")
   * @param version - Server version (default: "0.1.0")
   * @returns A configured Server instance with tools capability
   */
  createServer(
    name: string = "apcore-mcp",
    version: string = "0.1.0",
  ): Server {
    // [D10-002] Cross-language parity: the spec mandates a non-empty name
    // no longer than 255 chars. Python and Rust both throw on violation
    // before constructing the underlying Server.
    if (!name || name.length > 255) {
      throw new Error(
        `Server name must be non-empty and ≤255 chars, got ${name?.length ?? 0}`,
      );
    }
    // Advertise listChanged: true so MCP clients receive
    // notifications/tools/list_changed and notifications/resources/list_changed
    // when the registry mutates at runtime. Python's build_init_options and
    // Rust's MCPServerFactory::build_init_options both set this to true;
    // the TS factory previously passed empty objects, breaking dynamic-tool
    // registration on TS-hosted servers. [A-D-004]
    return new Server(
      { name, version },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
        },
      },
    );
  }

  /**
   * Build an MCP Tool object from an apcore module descriptor.
   *
   * Maps descriptor fields to MCP Tool format:
   * - name = descriptor.moduleId
   * - description = descriptor.description
   * - inputSchema = converted via SchemaConverter
   * - annotations = mapped from AnnotationMapper with camelCase keys
   */
  buildTool(descriptor: ModuleDescriptor, options?: BuildToolOptions): Tool {
    if (!descriptor.moduleId || typeof descriptor.moduleId !== "string") {
      throw new Error("ModuleDescriptor.moduleId is required and must be a string");
    }
    // Reject reserved __apcore_ prefix at the symbol boundary, not just
    // the bulk path. Direct callers (extensions, plugins, tests) would
    // otherwise produce a poisoned Tool that shadows the async-task
    // meta-tools. Python rejects at this same boundary; TS now does too.
    // [A-D-009]
    if (descriptor.moduleId.startsWith(APCORE_META_TOOL_PREFIX)) {
      throw new Error(
        `Reserved module id: "${descriptor.moduleId}". Module ids starting with ` +
          `"${APCORE_META_TOOL_PREFIX}" are reserved for apcore-mcp meta-tools.`,
      );
    }
    if (descriptor.description !== undefined && descriptor.description !== null && typeof descriptor.description !== "string") {
      throw new Error("ModuleDescriptor.description must be a string");
    }

    // NOTE: TypeScript uses AnnotationMapper.toMcpAnnotations() directly,
    // while Python uses SchemaExporter.export_mcp() for the same mapping.
    // Both produce identical output. If annotation logic changes, update both paths.
    const mcpAnnotations = this._annotationMapper.toMcpAnnotations(
      descriptor.annotations,
    );

    const strict = options?.strict ?? true;
    let convertedSchema: JsonSchema | undefined;
    if (strict && options?.registry && typeof options.registry.exportSchema === "function") {
      try {
        const exported = options.registry.exportSchema(descriptor.moduleId, true);
        const inputSchema = (exported as Record<string, unknown> | null)?.["input_schema"]
          ?? (exported as Record<string, unknown> | null)?.["inputSchema"];
        if (inputSchema && typeof inputSchema === "object") {
          convertedSchema = inputSchema as JsonSchema;
        }
      } catch {
        // Fall through to local conversion
      }
    }
    if (!convertedSchema) {
      convertedSchema = this._schemaConverter.convertInputSchema(descriptor, { strict });
    }

    const hasApproval = this._annotationMapper.hasRequiresApproval(descriptor.annotations);

    // Resolve display overlay fields (§5.13)
    const metadata = descriptor.metadata ?? {};
    const display = (metadata.display as Record<string, unknown>) ?? {};
    const mcpDisplay = (display.mcp as Record<string, unknown>) ?? {};

    const toolName: string = (mcpDisplay.alias as string) || descriptor.moduleId;
    // Description resolution chain:
    //   1. Operator-typed `display.mcp.description` (hard override).
    //   2. apcore-toolkit `formatModule({ style: "markdown" })` when
    //      `richDescription` is on AND the toolkit is primed — packs
    //      structured tool metadata (parameters, returns, behavior
    //      table, examples) into the description string the LLM reads.
    //   3. Plain `descriptor.description`.
    let description: string;
    if (mcpDisplay.description) {
      description = mcpDisplay.description as string;
    } else if (this._richDescription && isMarkdownAvailable()) {
      const md = renderModuleMarkdownSync(descriptor);
      description = md ?? descriptor.description;
    } else {
      if (this._richDescription && !isMarkdownAvailable() && !this._warnedToolkitMissing) {
        this._warnedToolkitMissing = true;
        console.warn(
          "MCPServerFactory: richDescription=true but apcore-toolkit is not " +
            "available. Call `await MCPServerFactory.prepare()` during startup, " +
            "or install `apcore-toolkit` as an optional peer dependency. " +
            "Falling back to plain descriptions.",
        );
      }
      description = descriptor.description;
    }

    // Append guidance if present (AI usage hints)
    const guidance = mcpDisplay.guidance as string | undefined;
    if (guidance) {
      description = `${description}\n\nGuidance: ${guidance}`;
    }

    // Append legacy x- AI intent metadata for backward compatibility
    const intentParts: string[] = [];
    for (const key of AI_INTENT_KEYS) {
      const val = metadata[key];
      if (val && typeof val === "string") {
        const label = key.replace("x-", "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        intentParts.push(`${label}: ${val}`);
      }
    }
    if (intentParts.length > 0) {
      description += "\n\n" + intentParts.join("\n");
    }

    const tool: Tool = {
      name: toolName,
      description,
      inputSchema: convertedSchema as Tool["inputSchema"],
      annotations: {
        readOnlyHint: mcpAnnotations.readOnlyHint,
        destructiveHint: mcpAnnotations.destructiveHint,
        idempotentHint: mcpAnnotations.idempotentHint,
        openWorldHint: mcpAnnotations.openWorldHint,
      },
    };

    const hasStreaming = descriptor.annotations?.streaming === true;

    if (hasApproval || hasStreaming) {
      const meta: Record<string, unknown> = {};
      if (hasApproval) {
        meta.requiresApproval = true;
      }
      if (hasStreaming) {
        meta.streaming = true;
      }
      (tool as Tool & { _meta?: Record<string, unknown> })._meta = meta;
    }

    return tool;
  }

  /**
   * Build an array of MCP Tool objects from all modules in a registry.
   *
   * Iterates over registry.list(), gets each definition, and builds tools.
   * Skips modules that return null definitions or throw errors (with console.warn).
   *
   * Reserved: module ids starting with `__apcore_` collide with the async
   * task bridge meta-tool namespace and are rejected with a console.error.
   */
  buildTools(registry: Registry, options?: BuildToolsOptions): Tool[] {
    const tools: Tool[] = [];
    const moduleIds = registry.list({
      tags: options?.tags ?? null,
      prefix: options?.prefix ?? null,
    });

    for (const moduleId of moduleIds) {
      if (moduleId.startsWith(APCORE_META_TOOL_PREFIX)) {
        throw new Error(
          `Reserved module id "${moduleId}" — ids prefixed with ` +
            `"${APCORE_META_TOOL_PREFIX}" are reserved for apcore-mcp meta-tools.`,
        );
      }
      try {
        const descriptor = registry.getDefinition(moduleId);
        if (descriptor === null) {
          console.warn(
            `Skipping module "${moduleId}": getDefinition returned null`,
          );
          continue;
        }
        tools.push(this.buildTool(descriptor, { strict: options?.strict, registry }));
      } catch (error) {
        console.warn(
          `Skipping module "${moduleId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return tools;
  }

  /**
   * Merge the four async-task meta-tools onto an existing tool list. Called
   * after `buildTools()` when an `AsyncTaskBridge` is active so meta-tools
   * are advertised via `tools/list`.
   */
  attachAsyncMetaTools(tools: Tool[], bridge: AsyncTaskBridge | undefined): Tool[] {
    if (!bridge || !bridge.enabled) return tools;
    const metaTools = bridge.buildMetaTools().map((mt) => ({
      name: mt.name,
      description: mt.description,
      inputSchema: mt.inputSchema as Tool["inputSchema"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })) as Tool[];
    return [...tools, ...metaTools];
  }

  /**
   * Register resources/list and resources/read handlers for modules with documentation.
   *
   * Iterates over registry.list(), gets each definition, and filters for
   * descriptors that have a non-null `documentation` field. Registers:
   * - resources/list: returns Resource objects with URI docs://{module_id}
   * - resources/read: returns documentation text for the requested module
   *
   * @param server - The MCP Server to register handlers on
   * @param registry - Registry to discover modules with documentation
   */
  registerResourceHandlers(
    server: Server,
    registry: Registry,
  ): void {
    // Build a map of module_id -> documentation for modules with docs
    const docsMap = new Map<string, string>();
    const moduleIds = registry.list();

    for (const moduleId of moduleIds) {
      try {
        const descriptor = registry.getDefinition(moduleId);
        if (descriptor?.documentation) {
          docsMap.set(moduleId, descriptor.documentation);
        }
      } catch {
        // Skip modules that throw errors
      }
    }

    // Handle resources/list requests
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: Resource[] = [];
      for (const [moduleId, _doc] of docsMap) {
        resources.push({
          uri: `docs://${moduleId}`,
          name: `${moduleId} documentation`,
          mimeType: "text/plain",
        });
      }
      return { resources };
    });

    // Handle resources/read requests
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const prefix = "docs://";
      if (!uri.startsWith(prefix)) {
        throw new Error(`Unsupported URI scheme: ${uri}`);
      }
      const moduleId = uri.slice(prefix.length);
      const documentation = docsMap.get(moduleId);
      if (documentation === undefined) {
        throw new Error(`Resource not found: ${uri}`);
      }
      const result: ReadResourceResult = {
        contents: [
          {
            uri,
            text: documentation,
            mimeType: "text/plain",
          },
        ],
      };
      return result;
    });
  }

  /**
   * Register tools/list and tools/call request handlers on a Server instance.
   *
   * @param server - The MCP Server to register handlers on
   * @param tools - Array of MCP Tool objects to serve
   * @param router - ExecutionRouter to handle tool call execution
   * @param options - Optional extra options; `asyncTaskBridge` adds meta-tools
   *                  and routes meta-tool calls to the bridge (mirrors Python's
   *                  `register_handlers(server, tools, router, async_bridge)`).
   *                  [D11-014]
   */
  registerHandlers(
    server: Server,
    tools: Tool[],
    router: ExecutionRouter,
    options?: { asyncTaskBridge?: AsyncTaskBridge; approvalBridge?: ApprovalBridge },
  ): void {
    // [D11-014] If asyncTaskBridge is provided, extend tools list with meta-tools.
    const bridge = options?.asyncTaskBridge;
    const approvalBridge = options?.approvalBridge;
    let allTools: Tool[] = bridge ? this.attachAsyncMetaTools(tools, bridge) : tools;

    // Append approval bridge meta-tools if present.
    if (approvalBridge) {
      allTools = [...allTools, ...approvalBridge.buildMetaTools()];
    }

    // Handle tools/list requests
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: allTools };
    });

    // Handle tools/call requests
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      // Build HandleCallExtra from MCP SDK extra
      const handleCallExtra: HandleCallExtra = {
        sendNotification: extra?.sendNotification
          ? (notification: Record<string, unknown>) =>
              extra.sendNotification(notification as any)
          : undefined,
        sendRequest: extra?.sendRequest
          ? (request: Record<string, unknown>, resultSchema: unknown) =>
              (extra.sendRequest as Function)(request, resultSchema)
          : undefined,
        _meta: extra?._meta
          ? { progressToken: extra._meta.progressToken }
          : undefined,
        // [A-D-018] Forward the transport's per-session id so the bridge
        // can record it for cancelSessionTasks() on transport disconnect.
        sessionId: (extra as { sessionId?: string } | undefined)?.sessionId,
      };

      const reqMeta = (request.params as { _meta?: Record<string, unknown> })._meta;
      const apcoreMeta = reqMeta?.["apcore"] as { version?: string } | undefined;
      if (apcoreMeta?.version) {
        handleCallExtra._meta = {
          ...(handleCallExtra._meta ?? {}),
          apcore: { version: apcoreMeta.version },
        };
      }

      // F-042: W3C trace_context ↔ MCP `_meta.traceparent` inbound propagation.
      // Prefer request params `_meta.traceparent`; fall back to transport extra.
      const rawTraceparent =
        (reqMeta?.["traceparent"] as string | undefined) ??
        (extra?._meta as { traceparent?: string } | undefined)?.traceparent;
      if (typeof rawTraceparent === "string" && rawTraceparent.length > 0) {
        handleCallExtra._meta = {
          ...(handleCallExtra._meta ?? {}),
          traceparent: rawTraceparent,
        };
      }

      // [A-D-014] Auth-identity propagation: thread the authenticated
      // identity from the AsyncLocalStorage (set by AuthMiddleware) into
      // the call extra so the router can attach it to the apcore Context.
      // Mirrors Python's factory pattern (factory.py:232-234) which reads
      // auth_identity_var.get() and forwards into extra["identity"].
      try {
        const { getCurrentIdentity } = await import("../auth/storage.js");
        const identity = getCurrentIdentity();
        if (identity !== null) {
          (handleCallExtra as HandleCallExtra & { identity?: unknown }).identity = identity;
        }
      } catch {
        // auth module not available — skip silently (auth is optional).
      }

      // Dispatch to approval bridge meta-tool if applicable (AFTER async bridge,
      // BEFORE the async-hint route in router.handleCall).
      if (approvalBridge && ApprovalBridge.isMetaTool(name)) {
        const [apContent, apIsError] = await approvalBridge.handleMetaTool(name, toolArgs);
        const apTextContents = apContent.map(c => ({ type: "text" as const, text: c.text }));
        if (apIsError) {
          throw new Error(apTextContents[0]?.text ?? "Unknown approval error");
        }
        return { content: apTextContents };
      }

      const [content, isError, traceId] = await router.handleCall(
        name,
        toolArgs,
        handleCallExtra,
      );

      const textContents = content.map(c => ({ type: "text" as const, text: c.text }));

      // NOTE: The MCP SDK decorator always wraps our return in
      // CallToolResult(isError=false). Setting isError=true is not
      // supported by the current SDK decorator. For errors, we raise
      // so the SDK sets isError=true on the CallToolResult.
      if (isError) {
        throw new Error(textContents[0]?.text ?? "Unknown error");
      }

      const result: CallToolResult & { _meta?: Record<string, unknown> } = {
        content: textContents,
      };

      // F-042 outbound: attach `_meta.traceparent` so downstream MCP callers
      // can continue the same W3C trace chain. We emit it whenever we have a
      // traceId (i.e. a context was created) — the client can then thread it
      // into any follow-up tool invocations.
      if (traceId) {
        result._meta = {
          ...(result._meta ?? {}),
          traceparent: buildTraceparent(traceId),
        };
      }

      return result;
    });
  }
}

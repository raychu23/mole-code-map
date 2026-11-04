// T50 (core-audit agent-surfaces.md rank 3): shared across every Mole MCP tool file (server.ts, collisions-tool.ts,
// oneonone-tool.ts, compile-cascade-tool.ts) so each one states its annotations the same way, with no risk of a
// circular import between the tool files (they all import FROM here, never from server.ts for this).
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Every Mole tool that never writes and never makes an external (open-world) call -- the official filesystem
 * server's own convention (server.ts:331 `annotations: { readOnlyHint: true, openWorldHint: false }`). */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** structuredContent's declared type is a plain index-signature object; Mole's result types are named interfaces
 * without one, so every tool's return site casts through this (type-level widening only, no shape change). */
export const sc = (o: object): Record<string, unknown> => o as Record<string, unknown>;

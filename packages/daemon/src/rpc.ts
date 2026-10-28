// Newline-delimited JSON-RPC 2.0 over a local socket: the one wire format between the daemon and every client
// (VS Code extension, CLI, MCP server).
import type { MapState, Neighborhood } from '@mole/core';

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface DaemonStatus {
  state: 'starting' | 'indexing' | 'ready' | 'error';
  root: string;
  pid: number;
  commit?: string;
  files: number;
  partialFiles: number;
  nodes: number;
  edges: number;
  indexedAt?: number;
  lastError?: string;
}

/** What a client gets for `map` / `impact`: always a Neighborhood, even when the daemon cannot answer. */
export type MapResult = Neighborhood;

export function unavailable(message: string, state: MapState = 'index-unavailable'): Neighborhood {
  return { state, message, nodes: [], edges: [], more: [] };
}

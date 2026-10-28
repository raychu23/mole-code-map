import { DatabaseSync } from 'node:sqlite';
import type { Evidence, GraphEdge, GraphNode } from '@mole/core';

export type FileStatus = 'ok' | 'partial';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, status TEXT NOT NULL, error_count INTEGER NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, layer TEXT NOT NULL, status TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, commit_sha TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, layer TEXT NOT NULL, status TEXT NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  UNIQUE (from_id, to_id, kind, path, line));
CREATE INDEX IF NOT EXISTS edges_path ON edges(path);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
`;

/** Open (or create) a Mole graph database. Pass ':memory:' for tests. */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function clearFile(db: DatabaseSync, path: string): void {
  db.prepare('DELETE FROM nodes WHERE path = ?').run(path);
  db.prepare('DELETE FROM edges WHERE path = ?').run(path);
  db.prepare('DELETE FROM files WHERE path = ?').run(path);
}

export function insertNode(db: DatabaseSync, n: GraphNode & { evidence: Evidence }): void {
  db.prepare(
    'INSERT OR IGNORE INTO nodes (id, kind, name, layer, status, path, line, commit_sha) VALUES (?,?,?,?,?,?,?,?)',
  ).run(n.id, n.kind, n.name, n.layer, n.status, n.evidence.path, n.evidence.line, n.evidence.commit);
}

export function insertEdge(db: DatabaseSync, e: GraphEdge & { evidence: Evidence }): void {
  db.prepare(
    'INSERT OR IGNORE INTO edges (from_id, to_id, kind, layer, status, path, line, commit_sha) VALUES (?,?,?,?,?,?,?,?)',
  ).run(e.from, e.to, e.kind, e.layer, e.status, e.evidence.path, e.evidence.line, e.evidence.commit);
}

export function insertFile(db: DatabaseSync, path: string, status: FileStatus, errorCount: number, hash: string): void {
  db.prepare('INSERT OR REPLACE INTO files (path, status, error_count, hash) VALUES (?,?,?,?)').run(path, status, errorCount, hash);
}

/** Read the whole graph back as core types, so core's missingEvidence() can validate it. */
export function readGraph(db: DatabaseSync): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = db.prepare('SELECT * FROM nodes').all().map((r) => ({
    id: String(r.id), kind: r.kind as GraphNode['kind'], name: String(r.name), layer: r.layer as GraphNode['layer'],
    status: r.status as GraphNode['status'],
    evidence: { path: String(r.path), line: Number(r.line), commit: String(r.commit_sha) },
  }));
  const edges = db.prepare('SELECT * FROM edges').all().map((r) => ({
    from: String(r.from_id), to: String(r.to_id), kind: r.kind as GraphEdge['kind'], layer: r.layer as GraphEdge['layer'],
    status: r.status as GraphEdge['status'],
    evidence: { path: String(r.path), line: Number(r.line), commit: String(r.commit_sha) },
  }));
  return { nodes, edges };
}

export function readFiles(db: DatabaseSync): Array<{ path: string; status: FileStatus; errorCount: number }> {
  return db.prepare('SELECT path, status, error_count FROM files ORDER BY path').all().map((r) => ({
    path: String(r.path), status: r.status as FileStatus, errorCount: Number(r.error_count),
  }));
}

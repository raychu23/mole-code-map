// Mole graph schema (plan core_model + B2/B3). Every layer and surface reads these types.

/** Where a claim comes from: a file, a 1-based line and the commit it was read at. */
export interface Evidence {
  path: string; // repo-relative, forward slashes
  line: number; // 1-based
  commit: string; // full or short SHA the line was read at
}

/** How much a fact can be trusted (plan core_model.statuses). */
export type Status = 'observed' | 'accepted' | 'inferred' | 'stale' | 'drift' | 'planned';

/** Which layer a node or edge belongs to (plan core_model.layers). */
export type Layer = 'current' | 'roadmap' | 'curated' | 'activity';

export type NodeKind = 'package' | 'module' | 'file' | 'class' | 'function' | 'method' | 'type' | 'variable';
export type EdgeKind = 'imports' | 'calls' | 'extends' | 'implements' | 'references' | 'contains';

export interface GraphNode {
  id: string; // stable symbol id, see anchorKey()
  kind: NodeKind;
  name: string;
  layer: Layer;
  status: Status;
  evidence?: Evidence; // required for layer 'current'
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  layer: Layer;
  status: Status;
  evidence?: Evidence; // the line that creates the edge (import or call site)
}

/** Rename-proof identity of a code element a roadmap/curated node points at (plan B2). */
export interface Anchor {
  qualifiedName: string; // e.g. src/user/service.ts#UserService.find
  path: string;
  kind: NodeKind;
  signatureHash?: string;
}

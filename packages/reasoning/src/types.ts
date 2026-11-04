// Core types for Mole's reasoning engine (T42).
//
// Models a Dung abstract argumentation framework (args + attacks) with an
// optional Bench-Capon value-based audience filter, evaluated under grounded
// semantics only (see (internal reference removed)
// §3: preferred/complete/stable are NP/coNP/Pi2P-hard and intentionally out of
// scope here -- grounded is the unique, P-complete answer this package ships).

export type ArgId = string;

export interface ArgumentSpec {
  id: ArgId;
  /** Bench-Capon value this argument promotes, if any. */
  value?: string;
}

export interface Framework {
  args: ArgumentSpec[];
  /** [from, to] = "from attacks to". */
  attacks: [ArgId, ArgId][];
}

export type Label = 'in' | 'out' | 'undecided';

export interface Why {
  /** For an 'out' argument: one in-argument that defeats it. */
  defeatedBy?: ArgId;
  /** For an 'in' argument: the in-arguments that neutralized each of its attackers. */
  defendedBy?: ArgId[];
}

export interface EvaluationResult {
  labels: Record<ArgId, Label>;
  why: Record<ArgId, Why>;
}

/** Audience = value preference order, most preferred first (Bench-Capon VAF). */
export type Audience = string[];

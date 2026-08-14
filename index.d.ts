// TypeScript declarations for `da-sc-sdk`.
//
// Hand-maintained alongside `src/index.js`. If a public signature changes,
// update this file. The 5 public functions are at the bottom; supporting
// types are at the top.

// ─── Documents ─────────────────────────────────────────────────────────────

/**
 * A DA structured-content document. The shape the SDK loads, mutates, and
 * serializes. Always `{ metadata, data }`; `metadata.schemaName` identifies
 * the schema the document was authored against.
 */
export interface Document {
  metadata: {
    /** Identifies which schema this document was authored against. Required
     *  for `convertJsonToHtml` (becomes the outer block's class name). */
    schemaName: string;
    [key: string]: unknown;
  };
  /** The user-editable payload. Shape is determined by the schema. */
  data?: unknown;
}

/** RFC 6901 JSON Pointer into the document, rooted at `/data`. */
export type JsonPointer = string;

// ─── Schema issues (compile-time) ──────────────────────────────────────────

/** Reasons a schema cannot be fully compiled by the SDK. */
export type SchemaIssueReason =
  | 'unsupported-composition'   // allOf / oneOf / anyOf without sibling properties
  | 'unsupported-type'          // a `type` value the SDK doesn't model
  | 'type-as-array'             // `type: ['string', 'null']` (nullable types not supported)
  | 'missing-type'              // a node with no `type` declared
  | 'external-ref'              // a `$ref` that isn't a same-document `#/...`
  | 'unresolved-ref'            // a `#/...` ref that doesn't resolve
  | 'invalid-pattern';          // a `pattern` value that isn't a valid regex

export interface SchemaIssue {
  /** Machine code for what's wrong — branch on this. */
  reason: SchemaIssueReason;
  /**
   * Human-readable summary of the issue, derived from `reason`/`details`.
   * Location-independent (add location from `schemaPath`/`pointer`).
   */
  message: string;
  /**
   * RFC 6901 pointer to the offending construct in the *schema source*, rooted
   * at the schema (`/`). `$ref`s are re-rooted at their target, so an issue
   * inside a `$def` points at the def (`/$defs/YearAchievement`) rather than the
   * inlined usage site. This is the location to fix.
   */
  schemaPath: string;
  /**
   * RFC 6901 pointer to where the issue manifests in a *data instance*, rooted
   * at `/data` (array positions as `0`, `$ref`s resolved away). The SDK's
   * canonical addressing — the same space the model and data errors use.
   */
  pointer: string;
  /**
   * Structured, reason-specific context:
   * `type-as-array`/`unsupported-type` → `{ type }`,
   * `unsupported-composition` → `{ keyword, variants }`,
   * `external-ref`/`unresolved-ref` → `{ ref }`,
   * `invalid-pattern` → `{ pattern }`,
   * `missing-type` → `null`.
   */
  details: {
    type?: string | string[];
    keyword?: 'allOf' | 'oneOf' | 'anyOf';
    variants?: number;
    ref?: string;
    pattern?: string;
  } | null;
}

// ─── Validation errors (data-against-schema) ───────────────────────────────

/** JSON Schema keywords the SDK emits as validation errors. */
export type ValidationKeyword =
  | 'required'
  | 'type'
  | 'enum'
  | 'minLength'
  | 'maxLength'
  | 'pattern'
  | 'minimum'
  | 'maximum'
  | 'minItems'
  | 'maxItems';

/**
 * A single validation error. Shape mirrors ajv's per-entry shape with two
 * deliberate deviations:
 *
 *   1. `schemaPath` is omitted (would leak schema structure).
 *   2. `required` errors are emitted at the CHILD pointer (where the missing
 *      field would be), not the parent. `params.missingProperty` names the
 *      missing field.
 */
export interface ValidationError {
  keyword: ValidationKeyword;
  /** RFC 6901 pointer into the data, rooted at `/data`. */
  instancePath: JsonPointer;
  /** Keyword-specific structured context (e.g. `{ limit: 3 }` for
   *  `minLength`, `{ allowedValues: [...] }` for `enum`). */
  params: Record<string, unknown>;
  /** Human-readable sentence. Capitalized, period-terminated. */
  message: string;
}

/**
 * Pointer-keyed map of validation errors. One error per pointer (the first
 * failing check wins). UI consumers do `errors[pointer]?.message`; agents
 * iterate via `Object.values(errors)`.
 */
export type ErrorsByPointer = Record<JsonPointer, ValidationError>;

// ─── Model (runtime tree) ──────────────────────────────────────────────────

/** Field kinds the SDK can model. */
export type NodeKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'unsupported';

export interface ModelNode {
  /** Schema property key (`"name"`, `"tags"`, `"0"`, …) or `"data"` at root. */
  key: string;
  kind: NodeKind;
  /** RFC 6901 pointer to this node's value, rooted at `/data`. */
  pointer: JsonPointer;
  /** schema.title or the key as fallback. */
  label: string;
  /** schema.description — field help text; present only when the schema sets it. */
  description?: string;
  required: boolean;
  readonly: boolean;
  defaultValue?: unknown;
  /** Picked subset of validation keywords from the schema. */
  validation: Record<string, unknown>;
  /** Current value from the document at this pointer. */
  value: unknown;
  // Object-kind extras:
  children?: ModelNode[];
  // Array-kind extras:
  items?: ModelNode[];
  minItems?: number;
  maxItems?: number;
  itemLabel?: string;
  // Primitives with `enum`:
  enumValues?: unknown[];
  // String primitives with `x-semantic-type` (vendor presentation hint):
  semanticType?: string;
  // Unsupported-kind extras:
  unsupported?: {
    reason: string;
    feature: string;
    compositionKeyword?: string;
    variants?: number;
    schemaPath?: string;
    details?: unknown;
  };
  unsupportedComposition?: {
    compositionKeyword: string;
    variants: number;
    schemaPath: string;
  };
}

export interface Model {
  root: ModelNode;
  /** Plain object keyed by JSON Pointer for O(1) lookup. */
  byPointer: Record<JsonPointer, ModelNode>;
  /** The normalized document the model was built from (do not mutate). */
  document: Document;
}

// ─── State (what getState / onChange callers see) ──────────────────────────

export interface EditorState {
  document: Document | null;
  model: Model | null;
  validation: { errors: ErrorsByPointer };
  schemaIssues: SchemaIssue[];
}

// ─── Engine (the object createEngine returns) ──────────────────────────────

export interface Engine {
  /** Returns the current state snapshot. Plain JSON, safe to `JSON.stringify`. */
  getState(): EditorState;

  /** Set a primitive value at `pointer`. */
  setField(pointer: JsonPointer, value: unknown): EditorState;

  /** Append a new item to the array at `pointer`. */
  addItem(pointer: JsonPointer): EditorState;

  /** Insert a new item BEFORE the item at `pointer`. */
  insertItem(pointer: JsonPointer): EditorState;

  /** Remove the item at `pointer`. */
  removeItem(pointer: JsonPointer): EditorState;

  /** Move an array item from `fromIndex` to `toIndex` within the array at `pointer`. */
  moveItem(pointer: JsonPointer, fromIndex: number, toIndex: number): EditorState;
}

// ─── Public API: the 5 exports ─────────────────────────────────────────────

/**
 * Create a schema-constrained JSON state engine. Compiles the schema,
 * parses the document, builds the initial model and validation — all
 * synchronously, before returning.
 *
 * `onChange` is NOT called during initialization. Read the initial state via
 * `engine.getState()`; `onChange` only fires for subsequent mutations.
 *
 * To start over with a different (schema, document), create a new engine.
 */
export function createEngine(options?: {
  schema?: unknown;
  document?: Document | null;
  /** Called after every mutation (not at creation). Read via `engine.getState()`. */
  onChange?: () => void;
}): Engine;

/**
 * Schema-only validation. Checks whether a schema is well-formed per the
 * SDK's schema dialect — without involving any data.
 *
 * `valid` is true iff `schemaIssues` is empty.
 */
export function validateSchema(options?: {
  schema: unknown;
}): { valid: boolean; schemaIssues: SchemaIssue[] };

/**
 * Data validation against a schema. Returns ajv-shaped errors (minus
 * `schemaPath`) keyed by pointer, plus any schema issues found while
 * compiling.
 *
 * `valid` is true iff BOTH `schemaIssues` AND `errors` are empty — a
 * document can't be valid against a broken schema. Symmetric with
 * `validateSchema`: both validators expose `valid` + `schemaIssues`;
 * `validateData` adds `errors` for data-level failures.
 */
export function validateData(options?: {
  schema: unknown;
  data?: unknown;
}): { valid: boolean; errors: ErrorsByPointer; schemaIssues: SchemaIssue[] };

/**
 * JSON → DA wire-format HTML. Prunes empty / null / whitespace leaves
 * before emitting (same shape the editor saves). Pure string builder,
 * no DOM. Symmetric pair with `convertHtmlToJson`.
 */
export function convertJsonToHtml(options: {
  json: Document;
}): { html: string } | { error: string };

/**
 * DA wire-format HTML → JSON. Symmetric pair with `convertJsonToHtml`.
 * Returns `{ error }` on empty / malformed input — never silently null.
 */
export function convertHtmlToJson(options?: {
  html: string;
}): { json: Document } | { error: string };

/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { compileSchema } from './schema.js';
import { buildModel, nodeAt } from './model.js';
import { validateDocument } from './validation.js';
import { definitionAt, getParentPointer } from './pointer.js';
import { isDataEmpty } from './empty.js';
import {
  addItem as applyAdd,
  insertItem as applyInsert,
  moveItem as applyMove,
  removeItem as applyRemove,
  setField as applySet,
} from './mutate.js';
import { deepClone } from './clone.js';

function parseDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) { return null; }

  const next = deepClone(document);
  if (next.metadata === undefined) { next.metadata = {}; }

  if (next.metadata === null || typeof next.metadata !== 'object' || Array.isArray(next.metadata)) {
    return null;
  }
  if (!('data' in next)) { return null; }

  if (next.data === null || typeof next.data !== 'object') { return null; }

  return next;
}

// The canonical "form-empty" predicate lives in ./empty.js so validation,
// defaults, and save all decide presence the same way. Re-exported here to
// keep the existing import surface (and the isDataEmpty ↔ prune symmetry test).
export { isDataEmpty };

// Walk the compiled definition tree and produce a partial document containing
// only keys that carry a real schema default (recursively). Fields without
// defaults stay absent so they get pruned to nothing on save instead of being
// written as empty placeholders. Arrays stay empty — fabricating items is the
// job of mutate.js's `addItem`, not load.
//
// Distinct from mutate.js's `buildDefault`, which seeds a complete shape for a
// new array item (so an input box can render). The two have different jobs and
// stay separate on purpose.
export function materializeDefaults(definition) {
  if (!definition || typeof definition !== 'object') { return undefined; }
  if (definition.defaultValue !== undefined) {
    return deepClone(definition.defaultValue);
  }
  if (definition.kind === 'object') {
    const result = {};
    for (const child of definition.children ?? []) {
      const value = materializeDefaults(child);
      if (value !== undefined) { result[child.key] = value; }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  // Booleans get an implicit default of `false`. A checkbox is always in one
  // of two states (checked or unchecked); there is no meaningful "absent."
  // `false` survives `prune()` on save, so the round-trip is stable.
  if (definition.kind === 'boolean') { return false; }
  return undefined;
}

// Coerce loaded data to the schema's primitive kinds. We walk both trees in
// lockstep and cast leaves; un-coercible values (e.g. "abc" against `integer`)
// pass through so the validator can still flag them with a clear message.
export function coerceData(value, definition) {
  if (!definition || value === null || value === undefined) { return value; }
  const { kind } = definition;

  if (kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) { return value; }
    const result = { ...value };
    for (const child of definition.children ?? []) {
      if (child.key in result) { result[child.key] = coerceData(result[child.key], child); }
    }
    return result;
  }

  if (kind === 'array') {
    if (!Array.isArray(value) || !definition.item) { return value; }
    return value.map((item) => coerceData(item, definition.item));
  }

  if (kind === 'number' || kind === 'integer') {
    if (typeof value === 'number') { return value; }
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    return value;
  }

  if (kind === 'boolean') {
    if (typeof value === 'boolean') { return value; }
    if (value === 'true') { return true; }
    if (value === 'false') { return false; }
    return value;
  }

  if (kind === 'string') {
    if (typeof value === 'string') { return value; }
    if (typeof value === 'number' || typeof value === 'boolean') { return String(value); }
    return value;
  }

  return value;
}

function emptyState({ document = null, schemaIssues = [] } = {}) {
  return {
    document,
    model: null,
    validation: { errors: {} },
    schemaIssues,
  };
}

function canAdd(definition, node) {
  if (!definition || definition.kind !== 'array') { return false; }
  if (!node || node.kind !== 'array') { return false; }
  if (definition.readonly) { return false; }
  // Cap on raw row count, not non-empty: maxItems bounds how many rows exist.
  // A non-empty cap would let blank rows be added without limit — don't.
  const count = node.items?.length ?? 0;
  return definition.maxItems === undefined || count < definition.maxItems;
}

function canRemove(definition, node) {
  if (!definition || definition.kind !== 'array') { return false; }
  if (!node || node.kind !== 'array') { return false; }
  if (definition.readonly) { return false; }
  // No minItems floor: removal is always allowed and a below-min result is
  // flagged by validation, not blocked. Do not re-add a floor — it would have to
  // be per-item to let blank rows go, making only some rows deletable.
  return (node.items?.length ?? 0) > 0;
}

function canReorder(definition, node) {
  if (!definition || definition.kind !== 'array') { return false; }
  if (!node || node.kind !== 'array') { return false; }
  if (definition.readonly) { return false; }
  return (node.items?.length ?? 0) > 1;
}

// Create a schema-constrained JSON state engine. Compiles the schema, parses
// and coerces the document, materializes defaults, builds the initial model,
// and runs validation — all synchronously, all before returning. The handle
// exposes mutations and `getState()`.
//
// `onChange` does NOT fire during initialization. Initial state is read via
// `engine.getState()`. Subsequent mutations trigger `onChange`.
//
// If `schema` is missing or malformed, the engine is still returned but
// `getState().schemaIssues` reports the problems and mutations are no-ops.
export function createEngine({ schema, document, onChange } = {}) {
  let state = emptyState();
  let definition = null;
  let schemaIssues = [];
  let model = null;
  let initialized = false;

  function getState() {
    return state;
  }

  function commitState(next) {
    state = next;
    // Skip the initial setup notification — onChange only fires for real
    // mutations after construction completes.
    if (initialized) { onChange?.(); }
  }

  function rebuildModel(nextDocument) {
    const built = buildModel({ definition, document: nextDocument });
    if (!built?.root) {
      commitState(emptyState({ document: nextDocument ?? null, schemaIssues }));
      return false;
    }
    model = built;
    const { errors } = validateDocument({ document: built.document, model });
    commitState({
      document: built.document,
      model: built,
      validation: { errors },
      schemaIssues,
    });
    return true;
  }

  function commit({ document: nextDocument, changed }) {
    if (!changed) { return state; }
    if (!rebuildModel(nextDocument)) { return state; }
    return state;
  }

  function canMutate() {
    return !!definition && !!model;
  }

  function arrayContext(pointer) {
    return {
      def: definitionAt({ definition, pointer }),
      node: nodeAt({ model, pointer }),
    };
  }

  // ─── Initialization ──────────────────────────────────────────────────────
  // Replaces the old `editor.load(...)` two-step. Runs synchronously at
  // construction. Mirrors `html/utils.js` for the empty-doc rule.
  {
    const compiled = compileSchema(schema);
    const parsed = parseDocument(document);
    definition = compiled.definition;
    schemaIssues = compiled.issues ?? [];

    if (!definition || !parsed) {
      state = emptyState({ document: parsed ?? null, schemaIssues });
    } else {
      parsed.data = coerceData(parsed.data, definition);
      if (isDataEmpty(parsed.data)) {
        const materialized = materializeDefaults(definition);
        if (materialized !== undefined) { parsed.data = materialized; }
      }
      rebuildModel(parsed);
    }
    initialized = true;
  }

  function setField(pointer, value) {
    if (!canMutate()) { return state; }
    const node = nodeAt({ model, pointer });
    if (node?.readonly) { return state; }
    return commit(applySet({
      document: state.document, pointer, value, node,
    }));
  }

  function addItem(pointer) {
    if (!canMutate()) { return state; }
    const { def, node } = arrayContext(pointer);
    if (!canAdd(def, node)) { return state; }
    return commit(applyAdd({
      document: state.document, pointer, itemDefinition: def.item,
    }));
  }

  function insertItem(pointer) {
    if (!canMutate()) { return state; }
    const parentPointer = getParentPointer(pointer);
    const { def, node } = arrayContext(parentPointer);
    if (!canAdd(def, node)) { return state; }
    return commit(applyInsert({
      document: state.document, pointer, itemDefinition: def.item,
    }));
  }

  function removeItem(pointer) {
    if (!canMutate()) { return state; }
    const parentPointer = getParentPointer(pointer);
    const { def, node } = arrayContext(parentPointer);
    if (!canRemove(def, node)) { return state; }
    return commit(applyRemove({ document: state.document, pointer }));
  }

  function moveItem(pointer, fromIndex, toIndex) {
    if (!canMutate()) { return state; }
    const from = Number.parseInt(fromIndex, 10);
    const to = Number.parseInt(toIndex, 10);
    if (!Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < 0) { return state; }

    const { def, node } = arrayContext(pointer);
    if (!canReorder(def, node)) { return state; }
    if (from >= (node.items?.length ?? 0)) { return state; }

    return commit(applyMove({
      document: state.document, pointer, fromIndex: from, toIndex: to,
    }));
  }

  return {
    getState,
    setField,
    addItem,
    insertItem,
    removeItem,
    moveItem,
  };
}

// Schema-only validation. Use when you want to know "is this schema well-formed
// per docs/schema-spec.md?" without involving any data. Returns
// `{ valid, schemaIssues }`. `valid` is true iff `schemaIssues` is empty.
export function validateSchema({ schema } = {}) {
  const compiled = compileSchema(schema);
  const schemaIssues = compiled?.issues ?? [];
  return {
    valid: schemaIssues.length === 0 && !!compiled?.definition,
    schemaIssues,
  };
}

// Data validation against a schema. Returns `{ valid, errors, schemaIssues }`.
// `valid` is true iff `schemaIssues` AND `errors` are both empty — you can't
// claim a document is valid against a broken schema. Symmetric with
// `validateSchema`: both validators expose `valid` + `schemaIssues`;
// `validateData` adds `errors` for data-level failures.
export function validateData({ schema, data } = {}) {
  const compiled = compileSchema(schema);
  const schemaIssues = compiled?.issues ?? [];
  if (!compiled?.definition) {
    return { valid: false, errors: {}, schemaIssues };
  }
  const document = { metadata: {}, data: data ?? {} };
  const model = buildModel({ definition: compiled.definition, document });
  const { errors } = validateDocument({ document, model });
  const valid = schemaIssues.length === 0 && Object.keys(errors).length === 0;
  return { valid, errors, schemaIssues };
}

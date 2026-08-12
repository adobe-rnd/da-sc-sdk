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

// Validation — emits a pointer-keyed map of errors.
//
// `state.validation.errors` is a plain object:
//
//   { [instancePath]: { keyword, instancePath, params, message } }
//
// Per-entry shape (the fields inside each value):
//
//   - `keyword`     — the JSON Schema keyword that failed (`minLength`,
//                     `pattern`, `enum`, `required`, `type`, `minimum`,
//                     `maximum`, `minItems`, `maxItems`). Stable vocabulary;
//                     matches what ajv would emit.
//   - `instancePath` — RFC 6901 pointer into the data, rooted at `/data`.
//                     Duplicated here so iteration (`Object.values(errors)`)
//                     yields entries that carry their own pointer.
//   - `params`      — keyword-specific structured info (`limit`, `pattern`,
//                     `allowedValues`, `missingProperty`, `type`).
//   - `message`     — human-readable sentence. Capitalized, period-terminated,
//                     no shouty caps. UI consumers render `.message` directly.
//
// We deliberately diverge from ajv on three things:
//
//   1. Outer shape is a pointer-keyed map, not an array. UI consumers do
//      O(1) lookup (`errors[pointer]`); agents iterate via
//      `Object.values(errors)`. One canonical shape — no parallel array.
//   2. `schemaPath` is omitted from every entry. It leaks schema structure
//      to whoever sees the errors and our consumers don't need it.
//   3. `required` lands on the CHILD pointer (where the missing field would
//      be), with `params.missingProperty` set. ajv puts it on the parent.
//      This keeps pointer construction inside the SDK — consumers never
//      compose parent + missingProperty themselves.
//
// One error per pointer by design: the first failing check per node wins.
// Invalid `pattern` is caught at schema-compile time (schema.js) and
// surfaces on `schemaIssues`, not here.

import { isDataEmpty } from './empty.js';

// First error per pointer wins. Helper makes that rule explicit at every
// call site instead of buried in the walk.
function pushError(errors, instancePath, error) {
  if (errors[instancePath] !== undefined) { return; }
  errors[instancePath] = { instancePath, ...error };
}

function validateString({ node, errors }) {
  const { value } = node;
  if (typeof value !== 'string') {
    pushError(errors, node.pointer, {
      keyword: 'type',
      params: { type: 'string' },
      message: 'Must be a string.',
    });
    return;
  }

  if (Array.isArray(node.enumValues) && !node.enumValues.includes(value)) {
    pushError(errors, node.pointer, {
      keyword: 'enum',
      params: { allowedValues: node.enumValues },
      message: 'Must be one of the allowed options.',
    });
    return;
  }

  const { validation = {} } = node;
  if (validation.minLength !== undefined && value.length < validation.minLength) {
    pushError(errors, node.pointer, {
      keyword: 'minLength',
      params: { limit: validation.minLength },
      message: `Must be at least ${validation.minLength} characters.`,
    });
    return;
  }
  if (validation.maxLength !== undefined && value.length > validation.maxLength) {
    pushError(errors, node.pointer, {
      keyword: 'maxLength',
      params: { limit: validation.maxLength },
      message: `Must be at most ${validation.maxLength} characters.`,
    });
    return;
  }
  if (validation.pattern !== undefined) {
    // pattern is guaranteed valid here — the compiler drops unparseable
    // patterns and pushes them to schemaIssues at compile time.
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) {
      pushError(errors, node.pointer, {
        keyword: 'pattern',
        params: { pattern: validation.pattern },
        // Include the pattern itself — the only field-specific detail we have.
        // A schema-authored message would be friendlier, but that is a separate
        // feature; showing the rule beats "the required pattern".
        message: `Must match the pattern "${validation.pattern}".`,
      });
    }
  }
}

function validateNumber({ node, errors }) {
  const { value } = node;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    pushError(errors, node.pointer, {
      keyword: 'type',
      params: { type: 'number' },
      message: 'Must be a number.',
    });
    return;
  }
  if (node.kind === 'integer' && !Number.isInteger(value)) {
    pushError(errors, node.pointer, {
      keyword: 'type',
      params: { type: 'integer' },
      message: 'Must be an integer.',
    });
    return;
  }

  const { validation = {} } = node;
  if (validation.minimum !== undefined && value < validation.minimum) {
    pushError(errors, node.pointer, {
      keyword: 'minimum',
      params: { limit: validation.minimum },
      message: `Must be greater than or equal to ${validation.minimum}.`,
    });
    return;
  }
  if (validation.maximum !== undefined && value > validation.maximum) {
    pushError(errors, node.pointer, {
      keyword: 'maximum',
      params: { limit: validation.maximum },
      message: `Must be less than or equal to ${validation.maximum}.`,
    });
  }
}

function validateBoolean({ node, errors }) {
  if (typeof node.value !== 'boolean') {
    pushError(errors, node.pointer, {
      keyword: 'type',
      params: { type: 'boolean' },
      message: 'Must be a boolean.',
    });
  }
}

function arrayMinMessage(min) {
  return min <= 1 ? 'Must contain at least one item.' : `Must contain at least ${min} items.`;
}

function validateArray({ node, errors }) {
  const { value } = node;
  if (!Array.isArray(value)) {
    pushError(errors, node.pointer, {
      keyword: 'type',
      params: { type: 'array' },
      message: 'Must be an array.',
    });
    return;
  }
  // Count only non-empty entries: empty items are stripped on save, so the
  // saved document would not actually contain them. Validating raw length lets
  // e.g. three blank rows satisfy minItems:3 even though none would persist.
  // Emptiness is RECURSIVE here — a row like `{ name: '' }` prunes to nothing,
  // so it must not count toward the minimum even though it has a key.
  const count = value.filter((item) => !isDataEmpty(item)).length;
  // A required array needs at least one non-empty item even without minItems —
  // otherwise a row full of blanks (which strips to nothing) looks satisfied.
  const min = node.required ? Math.max(node.minItems ?? 0, 1) : node.minItems;
  if (min !== undefined && count < min) {
    pushError(errors, node.pointer, {
      keyword: 'minItems',
      params: { limit: min },
      message: arrayMinMessage(min),
    });
    return;
  }
  if (node.maxItems !== undefined && count > node.maxItems) {
    pushError(errors, node.pointer, {
      keyword: 'maxItems',
      params: { limit: node.maxItems },
      message: `Must contain at most ${node.maxItems} items.`,
    });
  }
}

// A required object is a section and a required array needs items — "field"
// only fits a single input. Word the message to the control the author sees.
// An empty array never reaches the minItems check (it short-circuits as
// absent), so surface its minItems here when it asks for more than one.
function requiredMessage(child) {
  if (child.kind === 'object') { return 'This section is required.'; }
  if (child.kind === 'array') {
    // A required array needs at least one non-empty item (or minItems). Shares
    // the wording used by validateArray so both paths read the same.
    return arrayMinMessage(Math.max(child.minItems ?? 0, 1));
  }
  return 'This field is required.';
}

function emitRequiredForChildren({ node, errors }) {
  if (node.kind !== 'object' || !Array.isArray(node.children)) { return; }
  for (const child of node.children) {
    // Presence is RECURSIVE: a required object/array whose only content is
    // empty leaves (e.g. `{ title: '' }`) prunes away entirely on save, so it
    // must be flagged as missing even though it is a shallowly-populated value.
    if (child.required && isDataEmpty(child.value)) {
      pushError(errors, child.pointer, {
        keyword: 'required',
        params: { missingProperty: child.key },
        message: requiredMessage(child),
      });
    }
  }
}

function validateNodeValue({ node, errors }) {
  if (!node || !node.pointer) { return; }
  // Unsupported subtrees are not rendered; values pass through unvalidated.
  if (node.kind === 'unsupported') { return; }
  // Form-empty values count as absent — constraints (enum, pattern, etc.)
  // do not fire. Emptiness is recursive: an array of only blank rows, or an
  // object of only blank leaves, prunes to nothing on save, so it is treated
  // as absent here too. `required` is checked at the parent level separately,
  // so an empty required field is still flagged there.
  if (isDataEmpty(node.value)) { return; }

  if (node.kind === 'string') {
    validateString({ node, errors });
  } else if (node.kind === 'number' || node.kind === 'integer') {
    validateNumber({ node, errors });
  } else if (node.kind === 'boolean') {
    validateBoolean({ node, errors });
  } else if (node.kind === 'array') {
    validateArray({ node, errors });
  }
}

function traverse(node, errors) {
  if (!node) { return; }
  validateNodeValue({ node, errors });
  emitRequiredForChildren({ node, errors });
  if (Array.isArray(node.children)) { node.children.forEach((c) => traverse(c, errors)); }
  // Skip recursively-empty array rows: a blank row prunes to nothing on save,
  // so validating its interior (nested `required`, patterns, etc.) would flag
  // content that will never be persisted. The moment a row carries any value
  // it is validated normally.
  if (Array.isArray(node.items)) {
    node.items.forEach((c) => {
      if (!isDataEmpty(c.value)) { traverse(c, errors); }
    });
  }
}

export function validateDocument({ document, model }) {
  const errors = {};
  const root = model?.root;
  const data = document?.data;

  if (root && data === undefined) {
    pushError(errors, '/data', {
      keyword: 'required',
      params: { missingProperty: 'data' },
      message: 'This field is required.',
    });
    return { errors };
  }

  traverse(root, errors);

  return { errors };
}

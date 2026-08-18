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

// RFC 3339 shapes. date/time are floating (no offset); date-time is constrained
// to UTC (`Z`) with zero seconds — one canonical storage form for editor and
// script writers alike. Deliberately stricter than RFC 3339.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(?:\.0+)?Z$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidYmd(year, month, day) {
  if (month < 1 || month > 12 || day < 1) { return false; }
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

// Wall-clock components. Seconds allow 60 for RFC 3339 leap seconds.
function isValidHms(hour, minute, second) {
  return hour <= 23 && minute <= 59 && second <= 60;
}

// Returns a message when the value doesn't match its `format`, else null.
function formatError({ format, value }) {
  if (format === 'date') {
    const m = DATE_RE.exec(value);
    if (!m || !isValidYmd(+m[1], +m[2], +m[3])) {
      return 'Must be a valid date.';
    }
    return null;
  }
  if (format === 'time') {
    const m = TIME_RE.exec(value);
    if (!m || !isValidHms(+m[1], +m[2], m[3] ? +m[3] : 0)) {
      return 'Must be a valid time.';
    }
    return null;
  }
  if (format === 'date-time') {
    const m = DATE_TIME_RE.exec(value);
    if (!m || !isValidYmd(+m[1], +m[2], +m[3]) || !isValidHms(+m[4], +m[5], 0)) {
      return 'Must be a valid date and time.';
    }
    return null;
  }
  return null;
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

  if (node.format !== undefined) {
    const message = formatError({ format: node.format, value });
    if (message) {
      pushError(errors, node.pointer, {
        keyword: 'format',
        params: { format: node.format },
        message,
      });
      return;
    }
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
    // pattern is compiler-validated (unparseable ones become schemaIssues).
    const regex = new RegExp(validation.pattern);
    if (!regex.test(value)) {
      pushError(errors, node.pointer, {
        keyword: 'pattern',
        params: { pattern: validation.pattern },
        // Include the pattern itself — the only field-specific detail we have.
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
  // "with content": blank rows do not count — they prune on save.
  return min <= 1
    ? 'Must contain at least one item with content.'
    : `Must contain at least ${min} items with content.`;
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
  // Count only non-empty entries — blank items prune on save. Emptiness is
  // recursive: `{ name: '' }` prunes to nothing and must not count.
  const count = value.filter((item) => !isDataEmpty(item)).length;
  // A required array needs at least one non-empty item even without minItems.
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

// Word the required message to the control kind: object = section, array =
// item count (surfaced here since an empty array short-circuits as absent).
function requiredMessage(child) {
  if (child.kind === 'object') { return 'This section is required.'; }
  if (child.kind === 'array') {
    // Share validateArray's wording so both paths read the same.
    return arrayMinMessage(Math.max(child.minItems ?? 0, 1));
  }
  return 'This field is required.';
}

function emitRequiredForChildren({ node, errors }) {
  if (node.kind !== 'object' || !Array.isArray(node.children)) { return; }
  for (const child of node.children) {
    // Presence is recursive: a required container of only-empty leaves (e.g.
    // `{ title: '' }`) prunes to nothing on save, so flag it as missing.
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

  // An array is present once it has any rows (even blank), so its count
  // requirement surfaces; an empty array is absent, handled at the parent.
  if (node.kind === 'array') {
    const present = Array.isArray(node.value)
      ? node.value.length > 0
      : !isDataEmpty(node.value);
    if (present) { validateArray({ node, errors }); }
    return;
  }

  // An empty leaf is absent — value constraints do not fire. required is
  // enforced at the parent, so an empty required field is still flagged.
  if (isDataEmpty(node.value)) { return; }

  if (node.kind === 'string') {
    validateString({ node, errors });
  } else if (node.kind === 'number' || node.kind === 'integer') {
    validateNumber({ node, errors });
  } else if (node.kind === 'boolean') {
    validateBoolean({ node, errors });
  }
}

function traverse(node, errors) {
  if (!node) { return; }
  validateNodeValue({ node, errors });
  emitRequiredForChildren({ node, errors });
  if (Array.isArray(node.children)) { node.children.forEach((c) => traverse(c, errors)); }
  // Descend into every row, even blank ones: an added row's required fields
  // must validate (fill or remove it). Blank rows still don't count toward min.
  if (Array.isArray(node.items)) { node.items.forEach((c) => traverse(c, errors)); }
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

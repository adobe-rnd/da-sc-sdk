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

import { deepClone } from './clone.js';

function unionRequired(base = [], next = []) {
  return Array.from(new Set([...(base ?? []), ...(next ?? [])]));
}

function mergeSchemas(baseSchema = {}, nextSchema = {}) {
  const merged = { ...baseSchema, ...nextSchema };

  const baseProps = baseSchema?.properties ?? null;
  const nextProps = nextSchema?.properties ?? null;
  if (baseProps || nextProps) {
    merged.properties = { ...(baseProps ?? {}), ...(nextProps ?? {}) };
  }

  const baseDefs = baseSchema?.$defs ?? null;
  const nextDefs = nextSchema?.$defs ?? null;
  if (baseDefs || nextDefs) {
    merged.$defs = { ...(baseDefs ?? {}), ...(nextDefs ?? {}) };
  }

  merged.required = unionRequired(baseSchema.required, nextSchema.required);
  return merged;
}

function resolveRef({ ref, rootSchema }) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) { return null; }
  const segments = ref.slice(2).split('/').filter(Boolean);
  let current = rootSchema;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current == null || typeof current !== 'object') { return null; }
    current = current[key];
  }
  return current ?? null;
}

function escapeSchemaPathSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Append a suffix to a schema path without doubling the separator at the root
// (`/` + `/items` would otherwise be `//items`).
function joinSchemaPath(base, suffix) {
  return base === '/' ? `/${suffix}` : `${base}/${suffix}`;
}

function markUnsupportedComposition({
  node, compositionKeyword, variants, schemaPath,
}) {
  return {
    ...node,
    unsupportedComposition: { compositionKeyword, variants, schemaPath },
  };
}

function resolveNode({
  node, rootSchema, seenRefs, schemaPath,
}) {
  if (!node || typeof node !== 'object') { return node; }

  let resolved = { ...node };
  // The schema-source location for this node. When a `$ref` resolves, we
  // re-root here at the ref target (`#/$defs/Foo` → `/$defs/Foo`) so issues
  // point at the `$def` the author wrote, not the inlined usage site.
  let effectivePath = schemaPath;

  if (resolved.$ref) {
    const ref = resolved.$ref;
    const isInternal = typeof ref === 'string' && ref.startsWith('#/');

    if (!isInternal) {
      // External ref (URL, file path, or malformed). docs/schema-spec.md only
      // permits same-document `#/...` refs.
      return {
        ...resolved,
        $ref: undefined,
        unsupportedRef: { reason: 'external-ref', ref },
        schemaPath,
      };
    }

    if (seenRefs.has(ref)) {
      // Cycle: drop the ref and continue resolving the partial node we have.
      resolved = { ...resolved, $ref: undefined };
    } else {
      const target = resolveRef({ ref, rootSchema });
      if (!target) {
        // Internal but the pointer does not resolve in the document.
        return {
          ...resolved,
          $ref: undefined,
          unsupportedRef: { reason: 'unresolved-ref', ref },
          schemaPath,
        };
      }
      seenRefs.add(ref);
      effectivePath = ref.slice(1);
      const derefTarget = resolveNode({
        node: deepClone(target), rootSchema, seenRefs, schemaPath: effectivePath,
      });
      seenRefs.delete(ref);
      resolved = mergeSchemas(derefTarget, { ...resolved, $ref: undefined });
    }
  }

  const composition = (
    (Array.isArray(resolved.allOf) && resolved.allOf.length > 0 && { key: 'allOf', entries: resolved.allOf })
    || (Array.isArray(resolved.oneOf) && resolved.oneOf.length > 0 && { key: 'oneOf', entries: resolved.oneOf })
    || (Array.isArray(resolved.anyOf) && resolved.anyOf.length > 0 && { key: 'anyOf', entries: resolved.anyOf })
  );

  if (composition) {
    // All composition keywords are unsupported per docs/schema-spec.md. If the
    // node also has a direct `properties` map, mark the node and fall through
    // so the editable subset still renders; otherwise the whole node becomes
    // kind 'unsupported'.
    const hasDirectProperties = resolved.properties
      && typeof resolved.properties === 'object'
      && !Array.isArray(resolved.properties)
      && Object.keys(resolved.properties).length > 0;

    resolved = markUnsupportedComposition({
      node: resolved,
      compositionKeyword: composition.key,
      variants: composition.entries.length,
      schemaPath: effectivePath,
    });

    if (!hasDirectProperties) {
      // Only the first (ref-aware) pass sets the path; a redundant re-resolve of
      // an already-dereferenced subtree must not clobber a re-rooted $def path.
      resolved.schemaPath ??= effectivePath;
      return resolved;
    }

    resolved = { ...resolved, allOf: undefined, oneOf: undefined, anyOf: undefined };
  }

  if (resolved.items) {
    resolved.items = resolveNode({
      node: resolved.items,
      rootSchema,
      seenRefs,
      schemaPath: joinSchemaPath(effectivePath, 'items'),
    });
  }

  if (resolved.properties && typeof resolved.properties === 'object') {
    resolved.properties = Object.fromEntries(
      Object.entries(resolved.properties).map(([key, propertySchema]) => [
        key,
        resolveNode({
          node: propertySchema,
          rootSchema,
          seenRefs,
          schemaPath: joinSchemaPath(effectivePath, `properties/${escapeSchemaPathSegment(key)}`),
        }),
      ]),
    );
  }

  // Preserve a path set on a deeper (ref-aware) pass; only stamp if unset.
  resolved.schemaPath ??= effectivePath;
  return resolved;
}

function resolveSchema(schema) {
  if (!schema || typeof schema !== 'object') { return null; }

  const clone = deepClone(schema);
  const resolved = resolveNode({
    node: clone,
    rootSchema: clone,
    seenRefs: new Set(),
    schemaPath: '/',
  });

  return { schema: resolved };
}

const RULE_NAMES = ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern'];

function pickValidation(schema = {}) {
  return RULE_NAMES.reduce((acc, name) => {
    if (schema[name] !== undefined) { acc[name] = schema[name]; }
    return acc;
  }, {});
}

function getDefaults({ schema = {}, kind }) {
  return {
    readonly: !!(schema.readOnly ?? schema.readonly),
    defaultValue: schema.default,
    description: schema.description,
    validation: pickValidation(schema),
    minItems: kind === 'array' ? schema.minItems : undefined,
    maxItems: kind === 'array' ? schema.maxItems : undefined,
  };
}

function escapePointerSegment(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

const SUPPORTED_TYPES = new Set([
  'string', 'number', 'integer', 'boolean', 'object', 'array',
]);

// Recognized `x-semantic-type` values mapped to the JSON type each applies to.
// A value is surfaced to consumers only when the field's kind matches; any
// other value (or type mismatch) is dropped so consumers never receive a hint
// they can't act on.
const SEMANTIC_TYPES = new Map([
  ['long-text', 'string'],
]);

// Native JSON Schema string `format` values we surface to the UI as date/time
// widgets. Standard RFC 3339 keywords — no proprietary hint needed. Carried onto
// the node only when the field is a string; any other format value is dropped.
const DATE_FORMATS = new Set(['date', 'date-time', 'time']);

function unsupportedKind({ reason, feature, schemaPath = '/', variants = 0, details = null }) {
  return {
    kind: 'unsupported',
    unsupported: {
      reason,
      feature,
      compositionKeyword: feature,
      variants,
      schemaPath,
      details,
    },
  };
}

function inferKind(schema = {}) {
  if (schema?.unsupportedRef) {
    const r = schema.unsupportedRef;
    return unsupportedKind({
      reason: r.reason,
      feature: r.reason,
      details: { ref: r.ref },
    });
  }

  if (schema?.unsupportedComposition) {
    // If the node also has directly-defined properties, compile it as an object.
    // The composition itself is flagged via unsupportedComposition; the
    // editable subset still renders.
    if (
      schema.properties
      && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties)
    ) {
      return { kind: 'object' };
    }

    const u = schema.unsupportedComposition ?? {};
    const keyword = u.compositionKeyword ?? 'unknown';
    return unsupportedKind({
      reason: 'unsupported-composition',
      feature: keyword,
      variants: u.variants ?? 0,
      schemaPath: u.schemaPath ?? '/',
    });
  }

  if (Array.isArray(schema?.type)) {
    return unsupportedKind({
      reason: 'type-as-array',
      feature: 'type-as-array',
      details: { type: schema.type },
    });
  }

  if (typeof schema?.type === 'string') {
    if (SUPPORTED_TYPES.has(schema.type)) { return { kind: schema.type }; }
    return unsupportedKind({
      reason: 'unsupported-type',
      feature: schema.type,
      details: { type: schema.type },
    });
  }

  return unsupportedKind({
    reason: 'missing-type',
    feature: 'missing-type',
  });
}

// Human-readable summary of an issue, derived from its machine `reason` and
// `details`. `reason` stays the contract consumers branch on; `message` is the
// convenience string. Location-independent (consumers add it from `schemaPath`),
// period-terminated to match the data-validation error voice.
function issueMessage({ reason, details }) {
  switch (reason) {
    case 'missing-type':
      return 'A type is required.';
    case 'type-as-array':
      return 'The type must be a single value, not an array.';
    case 'unsupported-type':
      return `The type "${details?.type ?? ''}" is not supported.`;
    case 'unsupported-composition':
      return `Composition "${details?.keyword ?? ''}" is not supported.`;
    case 'external-ref':
      return `External reference "${details?.ref ?? ''}" is not supported; use a local "#/…" reference.`;
    case 'unresolved-ref':
      return `Reference "${details?.ref ?? ''}" could not be resolved.`;
    case 'invalid-pattern':
      return 'The pattern is not a valid regular expression.';
    default:
      return 'This schema construct is not supported.';
  }
}

function compileNode({
  key, schema, required = false, labelFallback = '', pointer = '/data', issues,
}) {
  const { kind, unsupported: inferred = null } = inferKind(schema);
  const label = schema?.title ?? labelFallback ?? key ?? '';
  const defaults = getDefaults({ schema, kind });
  // Where this node lives in the schema source (refs resolved to their $def).
  const schemaPath = schema?.schemaPath ?? '/';

  // Validate `pattern` at compile time. ajv treats an unparseable pattern as a
  // schema error (thrown at compile time, never reaches data validation); we
  // mirror that by surfacing it on `schemaIssues` and dropping it from the
  // node's `validation` so the data validator won't try to use it.
  if (typeof schema?.pattern === 'string' && defaults.validation.pattern !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(schema.pattern);
    } catch {
      const details = { pattern: schema.pattern };
      issues.push({
        reason: 'invalid-pattern',
        message: issueMessage({ reason: 'invalid-pattern', details }),
        schemaPath,
        pointer,
        details,
      });
      delete defaults.validation.pattern;
    }
  }

  const base = {
    key,
    kind,
    label,
    required,
    readonly: defaults.readonly,
    defaultValue: defaults.defaultValue,
    description: defaults.description,
    validation: defaults.validation,
  };

  if (kind === 'unsupported') {
    const u = inferred ?? {};
    const keyword = u.compositionKeyword ?? 'unknown';
    const reason = u.reason ?? 'unsupported-schema-feature';
    const feature = u.feature ?? keyword;
    // Composition folds its keyword + branch count into details; every other
    // reason keeps its own details blob ({ type } / { ref } / null).
    const issueDetails = reason === 'unsupported-composition'
      ? { keyword, variants: u.variants ?? 0 }
      : (u.details ?? null);
    issues.push({
      reason,
      message: issueMessage({ reason, details: issueDetails }),
      schemaPath,
      pointer,
      details: issueDetails,
    });

    return {
      ...base,
      kind: 'unsupported',
      readonly: true,
      unsupported: {
        compositionKeyword: keyword,
        feature,
        reason,
        variants: u.variants ?? 0,
        schemaPath,
        details: u.details ?? null,
      },
    };
  }

  if (kind === 'object') {
    const properties = schema?.properties ?? {};
    const requiredSet = new Set(schema?.required ?? []);

    if (schema?.unsupportedComposition) {
      const u = schema.unsupportedComposition;
      const keyword = u.compositionKeyword ?? 'unknown';
      const details = { keyword, variants: u.variants ?? 0 };
      issues.push({
        reason: 'unsupported-composition',
        message: issueMessage({ reason: 'unsupported-composition', details }),
        schemaPath,
        pointer,
        details,
      });
    }

    const node = {
      ...base,
      children: Object.entries(properties).map(([childKey, childSchema]) => (
        compileNode({
          key: childKey,
          schema: childSchema ?? {},
          required: requiredSet.has(childKey),
          labelFallback: childKey,
          pointer: `${pointer}/${escapePointerSegment(childKey)}`,
          issues,
        })
      )),
    };

    if (schema?.unsupportedComposition) {
      node.unsupportedComposition = schema.unsupportedComposition;
    }

    return node;
  }

  if (kind === 'array') {
    const itemSchema = schema?.items ?? {};
    return {
      ...base,
      minItems: defaults.minItems,
      maxItems: defaults.maxItems,
      item: compileNode({
        key: 'item',
        schema: itemSchema,
        required: false,
        labelFallback: itemSchema?.title ?? label,
        pointer: `${pointer}/0`,
        issues,
      }),
    };
  }

  if (Array.isArray(schema?.enum)) {
    return { ...base, enumValues: schema.enum };
  }

  if (kind === 'string' && DATE_FORMATS.has(schema?.format)) {
    return { ...base, format: schema.format };
  }

  // Vendor hint; `enum` and the standard `format` keyword take precedence above.
  if (SEMANTIC_TYPES.get(schema?.['x-semantic-type']) === kind) {
    return { ...base, semanticType: schema['x-semantic-type'] };
  }

  return base;
}

export function compileSchema(rawSchema) {
  const resolved = resolveSchema(rawSchema);
  if (!resolved?.schema) {
    return {
      schema: null,
      definition: null,
      editable: false,
      issues: [],
    };
  }

  const issues = [];
  const definition = compileNode({
    key: 'data',
    schema: resolved.schema,
    required: false,
    labelFallback: resolved.schema.title ?? 'Data',
    pointer: '/data',
    issues,
  });

  return {
    schema: resolved.schema,
    definition,
    editable: issues.length === 0,
    issues,
  };
}

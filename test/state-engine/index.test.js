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

import { expect } from '@esm-bundle/chai';
import {
  createEngine,
  coerceData,
  isDataEmpty,
  materializeDefaults,
} from '../../src/state-engine/index.js';
import { compileSchema } from '../../src/state-engine/schema.js';
import { convertJsonToHtml } from '../../src/html/json2html.js';

// Build an editor whose state changes can be observed by the test. The
// observation is deferred — call `start()` after `load()` to skip the load
// itself, mirroring how the form block's persistence attaches after load.
function createObservedEditor() {
  // Returns an engine plus a `calls` array that records every onChange
  // notification triggered by a real mutation. createEngine does NOT fire
  // onChange at init (initial state is read via getState()), so we don't
  // need a `start()` flag — the calls array only catches post-init events.
  const calls = [];
  let editor = null;
  let lastValues = null;
  return {
    init: ({ schema, document }) => {
      editor = createEngine({
        schema,
        document,
        onChange: () => {
          const next = editor.getState()?.document;
          if (next === lastValues) { return; }
          lastValues = next;
          calls.push({ document: next });
        },
      });
      lastValues = editor.getState()?.document;
      return editor;
    },
    get editor() { return editor; },
    calls,
  };
}

const baseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
  },
};

const baseDocument = {
  metadata: { schemaName: 'x' },
  data: { name: 'Alice', items: ['a', 'b'] },
};

describe('createEngine', () => {
  describe('initialization', () => {
    it('returns a state with model, document, and empty errors for a valid input', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      const state = core.getState();

      expect(state.model.root).to.exist;
      expect(state.document.data.name).to.equal('Alice');
      expect(state.validation.errors).to.deep.equal({});
    });

    it('builds a model with an unsupported root node when the root schema uses only unsupported composition', async () => {
      // An unsupported root (no direct properties) still produces a model so
      // the editor can render an inline "unsupported schema definition" message
      // rather than blocking the entire editor.
      const core = createEngine({
        schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        document: baseDocument,
      });
      const state = core.getState();
      expect(state.model).to.exist;
      expect(state.model.root.kind).to.equal('unsupported');
      expect(state.document.data.name).to.equal('Alice');
    });

    it('handles a malformed document without throwing', async () => {
      const core = createEngine({ schema: baseSchema, document: null });
      const state = core.getState();
      expect(state.model).to.equal(null);
    });
  });

  describe('schema evolution: fields removed from the schema', () => {
    // A document is authored against a rich schema (v1) exercising every
    // supported type, then the schema (v2) drops one field of each type.
    // Loading the older document must NOT silently strip the now-orphaned data —
    // the engine renders only the surviving field but keeps the full data
    // intact, for primitives, enums, arrays, and nested objects alike.
    // (Garbage-collecting orphaned data, if ever wanted, is a separate, explicit
    // operation — never a hidden side effect of loading.)

    // v2 keeps only `keptString`; every other property was removed from v1.
    const evolvedSchema = {
      type: 'object',
      properties: {
        keptString: { type: 'string' },
      },
    };

    // Authored against v1, which still defined all of these. Covers every
    // SUPPORTED_TYPE: string, number, integer, boolean, enum, array (of scalars
    // and of objects), and a nested object.
    const removedData = {
      removedString: 'gone-string',
      removedNumber: 3.14,
      removedInteger: 42,
      removedBooleanTrue: true,
      removedBooleanFalse: false,
      removedEnum: 'archived',
      removedScalarArray: ['a', 'b', 'c'],
      removedObjectArray: [
        { title: 'one', count: 1, active: true },
        { title: 'two', count: 2, active: false },
      ],
      removedNestedObject: {
        label: 'nested',
        meta: { weight: 9, flagged: true, tags: ['x', 'y'] },
      },
    };

    const olderDocument = {
      metadata: { schemaName: 'x' },
      data: { keptString: 'Alice', ...removedData },
    };

    it('keeps every removed-type field on the loaded document, byte-for-byte', () => {
      const core = createEngine({ schema: evolvedSchema, document: olderDocument });
      const { data } = core.getState().document;
      expect(data.keptString).to.equal('Alice');
      // Each removed field of each supported type survives unchanged.
      for (const [key, value] of Object.entries(removedData)) {
        expect(data[key]).to.deep.equal(value);
      }
    });

    it('does not coerce or normalize the orphaned values', () => {
      // coerceData walks the schema; removed fields have no definition, so their
      // values must pass through with their original types intact.
      const core = createEngine({ schema: evolvedSchema, document: olderDocument });
      const { data } = core.getState().document;
      expect(data.removedNumber).to.be.a('number');
      expect(data.removedInteger).to.equal(42);
      expect(data.removedBooleanFalse).to.equal(false);
      expect(data.removedScalarArray).to.be.an('array').with.lengthOf(3);
      expect(data.removedObjectArray[0].active).to.equal(true);
      expect(data.removedNestedObject.meta.tags).to.deep.equal(['x', 'y']);
    });

    it('builds a model node only for the surviving field', () => {
      const core = createEngine({ schema: evolvedSchema, document: olderDocument });
      const { byPointer } = core.getState().model;
      expect(byPointer['/data/keptString']).to.exist;
      for (const key of Object.keys(removedData)) {
        expect(byPointer[`/data/${key}`]).to.equal(undefined);
      }
    });

    it('preserves all orphaned fields when the surviving field is edited', () => {
      const core = createEngine({ schema: evolvedSchema, document: olderDocument });
      core.setField('/data/keptString', 'Bob');
      const { data } = core.getState().document;
      expect(data.keptString).to.equal('Bob');
      for (const [key, value] of Object.entries(removedData)) {
        expect(data[key]).to.deep.equal(value);
      }
    });

    it('does not mutate the caller-provided document object', () => {
      createEngine({ schema: evolvedSchema, document: olderDocument });
      // The engine deep-clones on load; the original is untouched either way.
      expect(olderDocument.data).to.deep.equal({ keptString: 'Alice', ...removedData });
    });
  });

  describe('setField', () => {
    it('updates state with the new value', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      core.setField('/data/name', 'Bob');
      expect(core.getState().document.data.name).to.equal('Bob');
    });

    it('notifies onChange on mutation', async () => {
      const harness = createObservedEditor();
      const editor = harness.init({ schema: baseSchema, document: baseDocument });
      editor.setField('/data/name', 'Bob');
      expect(harness.calls).to.have.lengthOf(1);
      expect(harness.calls[0].document.data.name).to.equal('Bob');
    });

    it('does not notify onChange when value is unchanged', async () => {
      const harness = createObservedEditor();
      const editor = harness.init({ schema: baseSchema, document: baseDocument });
      editor.setField('/data/name', 'Alice'); // same value as in baseDocument
      expect(harness.calls).to.have.lengthOf(0);
    });

    it('exposes the new value in the next state snapshot', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      const next = core.setField('/data/name', 'Carol');
      expect(next.document.data.name).to.equal('Carol');
      expect(core.getState().document.data.name).to.equal('Carol');
    });

    it('does not throw when called on an engine created without a schema (mutations are no-ops)', () => {
      const core = createEngine({}); // no schema, no document
      const state = core.setField('/data/name', 'x');
      // Engine returns its empty state; mutations are no-ops.
      expect(state.model).to.equal(null);
    });
  });

  describe('array operations', () => {
    it('addItem appends a default-valued item', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      const next = core.addItem('/data/items');
      expect(next.document.data.items).to.deep.equal(['a', 'b', '']);
    });

    it('insertItem inserts before the pointer and persists', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      const next = core.insertItem('/data/items/1');
      expect(next.document.data.items).to.deep.equal(['a', '', 'b']);
    });

    it('removeItem can empty a required array; validation flags the shortfall', async () => {
      const schema = {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', minItems: 2, items: { type: 'string' } },
        },
      };
      const core = createEngine({ schema, document: { metadata: {}, data: { items: ['a', 'b'] } } });
      // Removal is not floored: a required array at its minimum can still lose a
      // row. The shortfall surfaces as a validation error rather than a silent
      // no-op — the non-blocking model, and it avoids a misleading UI where some
      // rows are deletable and others are not.
      core.removeItem('/data/items/0');
      expect(core.getState().document.data.items).to.deep.equal(['b']);
      expect(core.getState().validation.errors['/data/items']?.message)
        .to.match(/at least 2 items with content/);
      // It can be emptied entirely too, which then reads as the required array
      // being missing — still flagged, never blocked.
      core.removeItem('/data/items/0');
      expect(core.getState().document.data.items).to.deep.equal([]);
      expect(core.getState().validation.errors['/data/items']).to.exist;
    });

    it('removeItem can clear an optional array below minItems', async () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array', minItems: 2, items: { type: 'string' } },
        },
      };
      const core = createEngine({ schema, document: { metadata: {}, data: { items: ['a', 'b'] } } });
      core.removeItem('/data/items/0');
      // An optional array can be emptied — minItems only constrains it when
      // present, and an empty optional array prunes to absent (valid).
      expect(core.getState().document.data.items).to.deep.equal(['b']);
    });

    it('addItem respects maxItems', async () => {
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 2, items: { type: 'string' } },
        },
      };
      const core = createEngine({ schema, document: { metadata: {}, data: { items: ['a', 'b'] } } });
      core.addItem('/data/items');
      expect(core.getState().document.data.items).to.have.lengthOf(2);
    });

    it('moveItem reorders the array', async () => {
      const core = createEngine({ schema: baseSchema, document: baseDocument });
      const next = core.moveItem('/data/items', 0, 1);
      expect(next.document.data.items).to.deep.equal(['b', 'a']);
    });

    it('moveItem with from===to is a no-op', async () => {
      const harness = createObservedEditor();
      const editor = harness.init({ schema: baseSchema, document: baseDocument });
      editor.moveItem('/data/items', 0, 0);
      expect(harness.calls).to.have.lengthOf(0);
      expect(editor.getState().document.data.items).to.deep.equal(['a', 'b']);
    });
  });

  describe('array-root documents', () => {
    const nestedArraySchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      title: 'Groups',
      items: {
        type: 'object',
        required: ['name', 'matrix'],
        properties: {
          name: { type: 'string', title: 'Name' },
          matrix: {
            type: 'array',
            title: 'Matrix',
            items: {
              type: 'array',
              title: 'Row',
              items: { type: 'string', title: 'Cell' },
            },
          },
        },
      },
    };

    const simpleArraySchema = {
      type: 'array',
      items: { type: 'string' },
    };

    it('builds a model when the schema root is an array and data is an array', async () => {
      const core = createEngine({
        schema: simpleArraySchema,
        document: { metadata: { schemaName: 'tags' }, data: ['x', 'y'] },
      });
      const state = core.getState();
      expect(state.model.root.kind).to.equal('array');
      expect(state.model.root.items).to.have.lengthOf(2);
      expect(state.validation.errors).to.deep.equal({});
    });

    it('walks a deeply nested array → object → array → array → string tree', async () => {
      const core = createEngine({
        schema: nestedArraySchema,
        document: {
          metadata: { schemaName: 'groups' },
          data: [{ name: 'alpha', matrix: [['a1', 'a2'], ['a3']] }],
        },
      });
      const state = core.getState();
      const item = state.model.root.items[0];
      expect(item.kind).to.equal('object');
      const matrix = item.children.find((c) => c.key === 'matrix');
      expect(matrix.kind).to.equal('array');
      expect(matrix.items[0].kind).to.equal('array');
      expect(matrix.items[0].items[0].kind).to.equal('string');
      expect(matrix.items[0].items[0].value).to.equal('a1');
      expect(state.validation.errors).to.deep.equal({});
    });

    it('mutates the root array via the /data pointer', async () => {
      const core = createEngine({
        schema: simpleArraySchema,
        document: { metadata: {}, data: ['x'] },
      });
      const next = core.addItem('/data');
      expect(next.document.data).to.deep.equal(['x', '']);
      expect(core.getState().document.data).to.deep.equal(['x', '']);
    });

    it('setField updates a leaf via a path that descends from the root array', async () => {
      const core = createEngine({
        schema: nestedArraySchema,
        document: { metadata: {}, data: [{ name: 'alpha', matrix: [['a1']] }] },
      });
      const next = core.setField('/data/0/name', 'gamma');
      expect(next.document.data[0].name).to.equal('gamma');
    });

    it('still rejects a document whose data is a non-container value', async () => {
      for (const data of ['scalar', 42, true, null]) {
        const core = createEngine({
          schema: simpleArraySchema,
          document: { metadata: {}, data },
        });
        expect(core.getState().model, `data=${JSON.stringify(data)}`).to.equal(null);
      }
    });
  });

  describe('defaults materialization', () => {
    // Schema with defaults at multiple positions, plus a field without a
    // default. Used across the scenarios below.
    const schemaWithDefaults = {
      type: 'object',
      properties: {
        a: { type: 'string', default: 'X' },
        b: { type: 'string', default: 'Y' },
        c: { type: 'string' },
      },
    };

    it('writes schema defaults into data when the loaded document is empty', async () => {
      const core = createEngine({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ a: 'X', b: 'Y' });
    });

    it('writes defaults when the loaded data is recursively empty', async () => {
      const core = createEngine({
        schema: schemaWithDefaults,
        // All leaves prune to nothing — treated identically to {}.
        document: { metadata: { schemaName: 'x' }, data: { a: '', b: null } },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ a: 'X', b: 'Y' });
    });

    it('does not materialize on a non-empty document — missing keys stay missing', async () => {
      const core = createEngine({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: { a: 'Alice' } },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ a: 'Alice' });
    });

    it('the first mutation produces state that includes materialized defaults', async () => {
      // The bug this guards against: the user edits one field on a fresh
      // document; the saved state must include the materialized defaults of
      // all other fields, not just the typed one. (Persistence itself is the
      // form block's concern; here we just verify the state shape.)
      const core = createEngine({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      core.setField('/data/c', 'Z');
      expect(core.getState().document.data).to.deep.equal({ a: 'X', b: 'Y', c: 'Z' });
    });

    it('does not notify onChange when a fresh engine is created but never mutated', async () => {
      const harness = createObservedEditor();
      harness.init({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      // createEngine doesn't fire onChange at init, so no notification.
      expect(harness.calls).to.have.lengthOf(0);
    });

    it('leaves data empty when the schema has no defaults', async () => {
      const core = createEngine({
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({});
    });

    it('clearing a materialized default removes the key from the document', async () => {
      const core = createEngine({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const next = core.setField('/data/a', '');
      expect(next.document.data).to.deep.equal({ b: 'Y' });
    });

    it('does not re-materialize when the user mutates a fresh document', async () => {
      // Materialization happens exactly once per load. A later mutation must
      // not bring back a default that the user just cleared.
      const core = createEngine({
        schema: schemaWithDefaults,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      core.setField('/data/a', '');
      const next = core.setField('/data/c', 'Z');
      expect(next.document.data).to.deep.equal({ b: 'Y', c: 'Z' });
    });

    it('materializes nested object defaults', async () => {
      const schema = {
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: {
              inner: { type: 'string', default: 'nested' },
            },
          },
        },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ outer: { inner: 'nested' } });
    });

    it('leaves arrays empty even when items have a default', async () => {
      // Fabricating array items is the job of `addItem`, not load.
      const schema = {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string', default: 'X' } },
        },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({});
    });

    it('materializes a boolean without an explicit default as false', async () => {
      const schema = {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ flag: false });
    });

    it('respects an explicit boolean default of true', async () => {
      const schema = {
        type: 'object',
        properties: { flag: { type: 'boolean', default: true } },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ flag: true });
    });

    it('materializes nested booleans inside objects', async () => {
      const schema = {
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: { flag: { type: 'boolean' } },
          },
        },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ outer: { flag: false } });
    });

    it('saves an unchanged false boolean alongside a typed field on first mutation', async () => {
      // Regression coverage for the original bug, applied to booleans: an
      // implicit-false checkbox the user never touched must still be saved.
      const schema = {
        type: 'object',
        properties: {
          flag: { type: 'boolean' },
          name: { type: 'string' },
        },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: {} },
      });
      core.setField('/data/name', 'Alice');
      expect(core.getState().document.data).to.deep.equal({ flag: false, name: 'Alice' });
    });

    it('exposes a saved enum value on node.value (drives select render)', async () => {
      // Regression coverage for the select-on-reload bug: after loading a
      // previously-saved document that picked an enum value, the model node
      // for that field must carry the value so the renderer can mark the
      // matching option as selected.
      const schema = {
        type: 'object',
        properties: { status: { type: 'string', enum: ['active', 'inactive'] } },
      };
      const core = createEngine({
        schema,
        document: { metadata: { schemaName: 'x' }, data: { status: 'active' } },
      });
      const state = core.getState();
      const node = state.model.byPointer['/data/status'];
      expect(node.value).to.equal('active');
      expect(node.enumValues).to.deep.equal(['active', 'inactive']);
    });

    it('reload of a saved {flag: false} stays unchecked (not re-materialized)', async () => {
      // Symmetry: `false` is non-empty, so the doc is non-fresh on reload and
      // the boolean reflects the saved state — including when that state is
      // false. No re-materialization occurs.
      const schema = {
        type: 'object',
        properties: { flag: { type: 'boolean', default: true } },
      };
      const core = createEngine({
        schema,
        // Previously saved as false — user unchecked a default-true checkbox.
        document: { metadata: { schemaName: 'x' }, data: { flag: false } },
      });
      const state = core.getState();
      expect(state.document.data).to.deep.equal({ flag: false });
    });
  });

  describe('coerceData (unit)', () => {
    function compile(schema) {
      return compileSchema(schema).definition;
    }

    it('casts string-encoded integers in an array to numbers', () => {
      const def = compile({
        type: 'object',
        properties: {
          priorities: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 5 } },
        },
      });
      const out = coerceData({ priorities: ['1', '2', '3'] }, def);
      expect(out.priorities).to.deep.equal([1, 2, 3]);
      out.priorities.forEach((v) => expect(typeof v).to.equal('number'));
    });

    it('casts a top-level string-encoded number to a number', () => {
      const def = compile({
        type: 'object',
        properties: { age: { type: 'number' } },
      });
      expect(coerceData({ age: '42' }, def)).to.deep.equal({ age: 42 });
    });

    it('passes through un-coercible numeric strings so the validator can flag them', () => {
      const def = compile({
        type: 'object',
        properties: { age: { type: 'integer' } },
      });
      expect(coerceData({ age: 'abc' }, def)).to.deep.equal({ age: 'abc' });
    });

    it('casts string-encoded booleans to booleans', () => {
      const def = compile({
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          flags: { type: 'array', items: { type: 'boolean' } },
        },
      });
      const out = coerceData({ enabled: 'true', flags: ['true', 'false'] }, def);
      expect(out).to.deep.equal({ enabled: true, flags: [true, false] });
    });

    it('stringifies a number when the schema declares string (heuristic typing was wrong)', () => {
      const def = compile({
        type: 'object',
        properties: { code: { type: 'string' } },
      });
      expect(coerceData({ code: 42 }, def)).to.deep.equal({ code: '42' });
    });

    it('recurses into objects nested inside arrays', () => {
      const def = compile({
        type: 'object',
        properties: {
          people: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                age: { type: 'integer' },
                active: { type: 'boolean' },
              },
            },
          },
        },
      });
      const out = coerceData(
        { people: [{ age: '30', active: 'true' }, { age: '40', active: 'false' }] },
        def,
      );
      expect(out.people).to.deep.equal([
        { age: 30, active: true },
        { age: 40, active: false },
      ]);
    });

    it('leaves keys that the schema does not mention untouched', () => {
      const def = compile({
        type: 'object',
        properties: { age: { type: 'integer' } },
      });
      const out = coerceData({ age: '5', extra: '99' }, def);
      expect(out).to.deep.equal({ age: 5, extra: '99' });
    });

    it('passes through null and undefined values', () => {
      const def = compile({
        type: 'object',
        properties: {
          a: { type: 'integer' },
          b: { type: 'string' },
        },
      });
      expect(coerceData({ a: null, b: undefined }, def))
        .to.deep.equal({ a: null, b: undefined });
    });

    it('returns the value untouched when no definition is provided', () => {
      expect(coerceData({ a: '1' }, null)).to.deep.equal({ a: '1' });
    });

    it('leaves an array value alone when the schema says scalar (no crash)', () => {
      const def = compile({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
      // Schema mismatch: array provided where string declared. Pass through so
      // the validator can produce a single clear error rather than coercing
      // into something the user did not intend.
      expect(coerceData({ name: ['a', 'b'] }, def)).to.deep.equal({ name: ['a', 'b'] });
    });
  });

  describe('materializeDefaults (unit)', () => {
    it('returns undefined for a definition with no defaults anywhere', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
      expect(materializeDefaults(definition)).to.equal(undefined);
    });

    it('returns only keys that carry a default (siblings without a default are omitted)', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: {
          a: { type: 'string', default: 'X' },
          b: { type: 'string' },
        },
      });
      expect(materializeDefaults(definition)).to.deep.equal({ a: 'X' });
    });

    it('deep-clones the default so mutating the result cannot poison the schema', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: {
          obj: { type: 'object', default: { nested: 'V' } },
        },
      });
      const result = materializeDefaults(definition);
      result.obj.nested = 'tampered';
      const fresh = materializeDefaults(definition);
      expect(fresh.obj.nested).to.equal('V');
    });

    it('returns false for a bare boolean definition without an explicit default', () => {
      const { definition } = compileSchema({ type: 'boolean' });
      expect(materializeDefaults(definition)).to.equal(false);
    });

    it('returns the schema default for a boolean when one is set', () => {
      const { definition } = compileSchema({ type: 'boolean', default: true });
      expect(materializeDefaults(definition)).to.equal(true);
    });
  });

  describe('isDataEmpty / prune symmetry', () => {
    // Critical invariant: a value the loader considers "empty" must also be
    // a value the serializer would prune from the saved HTML. If these two
    // ever drift, a doc could load as "fresh" yet save with content (or vice
    // versa), reintroducing the defaults-overwrite bug.
    function prunesToNothing(data) {
      const { html } = convertJsonToHtml({ json: { metadata: { schemaName: 'x' }, data } });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const block = doc.querySelector('.x');
      return !block || block.textContent.trim() === '';
    }

    const inputs = [
      {},
      { a: '' },
      { a: '   ' },
      { a: null },
      { a: undefined },
      { a: [] },
      { a: {} },
      { a: { b: '' } },
      { a: [{ b: '' }, ''] },
      { a: { b: { c: [] } } },
    ];

    inputs.forEach((input, i) => {
      it(`agrees with prune on case ${i}`, () => {
        expect(isDataEmpty(input)).to.equal(prunesToNothing(input));
      });
    });

    it('disagrees (correctly) when any leaf has content', () => {
      expect(isDataEmpty({ a: 'x' })).to.equal(false);
      expect(prunesToNothing({ a: 'x' })).to.equal(false);
    });
  });
});

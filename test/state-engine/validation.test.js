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
import { validateDocument } from '../../src/state-engine/validation.js';
import { compileSchema } from '../../src/state-engine/schema.js';
import { buildModel } from '../../src/state-engine/model.js';
import { prune } from '../../src/html/utils.js';

function setup(schema, data) {
  const { definition } = compileSchema(schema);
  const document = { metadata: {}, data };
  const model = buildModel({ definition, document });
  return validateDocument({ document, model });
}

describe('validateDocument', () => {
  it('returns an empty errors map for a clean document', () => {
    const { errors } = setup(
      { type: 'object', properties: { name: { type: 'string' } } },
      { name: 'ok' },
    );
    expect(errors).to.deep.equal({});
  });

  it('reports a missing root /data as a required error at /data', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const { definition } = compileSchema(schema);
    const document = { metadata: {} };
    const model = buildModel({ definition, document });
    const { errors } = validateDocument({ document, model });
    expect(errors).to.deep.equal({
      '/data': {
        keyword: 'required',
        instancePath: '/data',
        params: { missingProperty: 'data' },
        message: 'This field is required.',
      },
    });
  });

  describe('required', () => {
    it('flags missing required string at the child pointer with missingProperty', () => {
      const { errors } = setup(
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        { name: '' },
      );
      expect(errors).to.deep.equal({
        '/data/name': {
          keyword: 'required',
          instancePath: '/data/name',
          params: { missingProperty: 'name' },
          message: 'This field is required.',
        },
      });
    });

    it('treats whitespace-only as empty', () => {
      const { errors } = setup(
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        { name: '   ' },
      );
      expect(errors['/data/name']?.keyword).to.equal('required');
      expect(errors['/data/name']?.params?.missingProperty).to.equal('name');
    });

    it('flags an empty required array', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        { items: [] },
      );
      expect(errors['/data/items']?.keyword).to.equal('required');
      expect(errors['/data/items']?.params?.missingProperty).to.equal('items');
    });

    it('words the required message for the control: object is a section', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['seo'],
          properties: { seo: { type: 'object', properties: { mt: { type: 'string' } } } },
        },
        { seo: {} },
      );
      expect(errors['/data/seo']?.keyword).to.equal('required');
      expect(errors['/data/seo']?.message).to.equal('This section is required.');
    });

    it('words the required message for the control: array asks for an item', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        { items: [] },
      );
      expect(errors['/data/items']?.message).to.equal('Must contain at least one item with content.');
    });

    it('reflects minItems in the required message for an empty array', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', minItems: 3, items: { type: 'string' } } },
        },
        { items: [] },
      );
      expect(errors['/data/items']?.message).to.equal('Must contain at least 3 items with content.');
    });

    it('flags a required-field violation inside an array-root item at the field pointer', () => {
      // The row carries content (`note`) so it survives pruning — a row of only
      // blank leaves would be treated as absent and not validated.
      const { errors } = setup(
        {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, note: { type: 'string' } },
          },
        },
        [{ name: '', note: 'kept' }],
      );
      expect(errors['/data/0/name']?.keyword).to.equal('required');
      expect(errors['/data/0/name']?.params?.missingProperty).to.equal('name');
    });

    // A container can be shallowly populated (has a key / a row) yet recursively
    // empty — every leaf beneath it is blank, so `prune()` deletes it entirely
    // on save. Presence is checked recursively so these are flagged as missing
    // rather than silently dropping a required key from the saved document.
    it('flags a required object whose only leaves are empty', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['seo'],
          properties: { seo: { type: 'object', properties: { title: { type: 'string' } } } },
        },
        { seo: { title: '' } },
      );
      expect(errors['/data/seo']?.keyword).to.equal('required');
      expect(errors['/data/seo']?.message).to.equal('This section is required.');
    });

    it('flags both the section and its required child when a required section is empty', () => {
      // An empty required section reports at the section (it prunes away) AND at
      // its own required child — each at its own pointer.
      const { errors } = setup(
        {
          type: 'object',
          required: ['seo'],
          properties: {
            seo: {
              type: 'object',
              required: ['metaTitle'],
              properties: { metaTitle: { type: 'string' }, metaDescription: { type: 'string' } },
            },
          },
        },
        { seo: { metaTitle: '' } },
      );
      expect(errors['/data/seo']?.keyword).to.equal('required');
      expect(errors['/data/seo']?.message).to.equal('This section is required.');
      expect(errors['/data/seo/metaTitle']?.keyword).to.equal('required');
    });

    it('validates inside a section that has content (only the missing child fires)', () => {
      // The section is not empty (metaDescription has content), so it is not
      // flagged as required — but the missing required metaTitle still is.
      const { errors } = setup(
        {
          type: 'object',
          required: ['seo'],
          properties: {
            seo: {
              type: 'object',
              required: ['metaTitle'],
              properties: { metaTitle: { type: 'string' }, metaDescription: { type: 'string' } },
            },
          },
        },
        { seo: { metaTitle: '', metaDescription: 'A description.' } },
      );
      expect(errors['/data/seo']).to.equal(undefined);
      expect(errors['/data/seo/metaTitle']?.keyword).to.equal('required');
    });

    it('flags a required object-array whose only row is a blank object', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['tags'],
          properties: {
            tags: {
              type: 'array',
              minItems: 1,
              items: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
        { tags: [{ name: '' }] },
      );
      expect(errors['/data/tags']?.keyword).to.equal('required');
      expect(errors['/data/tags']?.message).to.equal('Must contain at least one item with content.');
    });
  });

  describe('string', () => {
    it('rejects minLength under', () => {
      const { errors } = setup(
        { type: 'object', properties: { name: { type: 'string', minLength: 3 } } },
        { name: 'ab' },
      );
      expect(errors).to.deep.equal({
        '/data/name': {
          keyword: 'minLength',
          instancePath: '/data/name',
          params: { limit: 3 },
          message: 'Must be at least 3 characters.',
        },
      });
    });

    it('rejects maxLength over', () => {
      const { errors } = setup(
        { type: 'object', properties: { name: { type: 'string', maxLength: 3 } } },
        { name: 'abcd' },
      );
      expect(errors).to.deep.equal({
        '/data/name': {
          keyword: 'maxLength',
          instancePath: '/data/name',
          params: { limit: 3 },
          message: 'Must be at most 3 characters.',
        },
      });
    });

    it('rejects non-matching pattern', () => {
      const { errors } = setup(
        { type: 'object', properties: { code: { type: 'string', pattern: '^\\d+$' } } },
        { code: 'abc' },
      );
      expect(errors).to.deep.equal({
        '/data/code': {
          keyword: 'pattern',
          instancePath: '/data/code',
          params: { pattern: '^\\d+$' },
          message: 'Must match the pattern "^\\d+$".',
        },
      });
    });

    it('does not run pattern check when the compiler dropped an invalid pattern', () => {
      // schema.js detects invalid patterns at compile time and drops them
      // from the node's validation — the data validator never sees one.
      const { errors } = setup(
        { type: 'object', properties: { code: { type: 'string', pattern: '[' } } },
        { code: 'x' },
      );
      expect(errors).to.deep.equal({});
    });

    it('rejects a non-string value with a type error', () => {
      const { errors } = setup(
        { type: 'object', properties: { name: { type: 'string' } } },
        { name: 42 },
      );
      expect(errors['/data/name']).to.deep.equal({
        keyword: 'type',
        instancePath: '/data/name',
        params: { type: 'string' },
        message: 'Must be a string.',
      });
    });
  });

  describe('format (date / date-time / time)', () => {
    const field = (format) => ({
      type: 'object', properties: { when: { type: 'string', format } },
    });

    it('accepts a valid date', () => {
      const { errors } = setup(field('date'), { when: '2026-08-14' });
      expect(errors).to.deep.equal({});
    });

    it('rejects a malformed date', () => {
      const { errors } = setup(field('date'), { when: '08/14/2026' });
      expect(errors['/data/when']).to.deep.equal({
        keyword: 'format',
        instancePath: '/data/when',
        params: { format: 'date' },
        message: 'Must be a valid date.',
      });
    });

    it('rejects an impossible calendar date', () => {
      const { errors } = setup(field('date'), { when: '2026-02-30' });
      expect(errors['/data/when']?.keyword).to.equal('format');
    });

    it('accepts Feb 29 on a leap year', () => {
      const { errors } = setup(field('date'), { when: '2024-02-29' });
      expect(errors).to.deep.equal({});
    });

    it('accepts a UTC date-time', () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T13:00:00Z' });
      expect(errors).to.deep.equal({});
    });

    it("accepts the editor's millisecond UTC form", () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T13:00:00.000Z' });
      expect(errors).to.deep.equal({});
    });

    it('rejects a non-UTC offset (one canonical storage form)', () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T13:00:00+02:00' });
      expect(errors['/data/when']?.keyword).to.equal('format');
      expect(errors['/data/when']?.params).to.deep.equal({ format: 'date-time' });
    });

    it('rejects non-zero seconds (minute precision only)', () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T13:00:30Z' });
      expect(errors['/data/when']?.keyword).to.equal('format');
    });

    it('rejects a date-time missing the offset (not an absolute instant)', () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T13:00:00' });
      expect(errors['/data/when']?.keyword).to.equal('format');
      expect(errors['/data/when']?.params).to.deep.equal({ format: 'date-time' });
    });

    it('accepts the minimum 4-digit-year boundary the editor can emit', () => {
      const { errors } = setup(field('date-time'), { when: '0001-01-01T00:00:00Z' });
      expect(errors).to.deep.equal({});
    });

    it('rejects a date-time with an out-of-range time component', () => {
      const { errors } = setup(field('date-time'), { when: '2026-08-14T24:00:00Z' });
      expect(errors['/data/when']?.keyword).to.equal('format');
    });

    it('rejects a date-time with an impossible calendar date', () => {
      const { errors } = setup(field('date-time'), { when: '2026-02-30T12:00:00Z' });
      expect(errors['/data/when']?.keyword).to.equal('format');
    });

    it('accepts a floating time with no offset', () => {
      const { errors } = setup(field('time'), { when: '09:00' });
      expect(errors).to.deep.equal({});
    });

    it('accepts a floating time with seconds', () => {
      const { errors } = setup(field('time'), { when: '09:00:30' });
      expect(errors).to.deep.equal({});
    });

    it('rejects an out-of-range time', () => {
      const { errors } = setup(field('time'), { when: '25:61' });
      expect(errors['/data/when']?.keyword).to.equal('format');
    });

    it('treats an empty value as absent (no format error)', () => {
      const { errors } = setup(field('date'), { when: '' });
      expect(errors).to.deep.equal({});
    });
  });

  describe('number / integer', () => {
    it('rejects below minimum', () => {
      const { errors } = setup(
        { type: 'object', properties: { age: { type: 'number', minimum: 5 } } },
        { age: 1 },
      );
      expect(errors['/data/age']).to.deep.equal({
        keyword: 'minimum',
        instancePath: '/data/age',
        params: { limit: 5 },
        message: 'Must be greater than or equal to 5.',
      });
    });

    it('rejects above maximum', () => {
      const { errors } = setup(
        { type: 'object', properties: { age: { type: 'number', maximum: 5 } } },
        { age: 9 },
      );
      expect(errors['/data/age']).to.deep.equal({
        keyword: 'maximum',
        instancePath: '/data/age',
        params: { limit: 5 },
        message: 'Must be less than or equal to 5.',
      });
    });

    it('rejects a non-integer when type is integer with a type:integer error', () => {
      const { errors } = setup(
        { type: 'object', properties: { n: { type: 'integer' } } },
        { n: 1.5 },
      );
      expect(errors['/data/n']).to.deep.equal({
        keyword: 'type',
        instancePath: '/data/n',
        params: { type: 'integer' },
        message: 'Must be an integer.',
      });
    });

    it('rejects a non-number value with a type error', () => {
      const { errors } = setup(
        { type: 'object', properties: { age: { type: 'number' } } },
        { age: 'old' },
      );
      expect(errors['/data/age']).to.deep.equal({
        keyword: 'type',
        instancePath: '/data/age',
        params: { type: 'number' },
        message: 'Must be a number.',
      });
    });
  });

  describe('boolean', () => {
    it('rejects a non-boolean value with a type error', () => {
      const { errors } = setup(
        { type: 'object', properties: { flag: { type: 'boolean' } } },
        { flag: 'yes' },
      );
      expect(errors['/data/flag']).to.deep.equal({
        keyword: 'type',
        instancePath: '/data/flag',
        params: { type: 'boolean' },
        message: 'Must be a boolean.',
      });
    });
  });

  describe('enum', () => {
    it('rejects a value not in enum and includes allowedValues in params', () => {
      const { errors } = setup(
        { type: 'object', properties: { color: { type: 'string', enum: ['a', 'b'] } } },
        { color: 'x' },
      );
      expect(errors['/data/color']).to.deep.equal({
        keyword: 'enum',
        instancePath: '/data/color',
        params: { allowedValues: ['a', 'b'] },
        message: 'Must be one of the allowed options.',
      });
    });

    it('accepts a value in enum', () => {
      const { errors } = setup(
        { type: 'object', properties: { color: { type: 'string', enum: ['a', 'b'] } } },
        { color: 'a' },
      );
      expect(errors).to.deep.equal({});
    });
  });

  describe('array', () => {
    it('rejects a non-array value with a type error', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        { items: 'not-an-array' },
      );
      expect(errors['/data/items']).to.deep.equal({
        keyword: 'type',
        instancePath: '/data/items',
        params: { type: 'array' },
        message: 'Must be an array.',
      });
    });

    it('rejects below minItems when the array has content', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 2, items: { type: 'string' } } },
        },
        { items: ['only-one'] },
      );
      expect(errors['/data/items']).to.deep.equal({
        keyword: 'minItems',
        instancePath: '/data/items',
        params: { limit: 2 },
        message: 'Must contain at least 2 items with content.',
      });
    });

    it('rejects above maxItems', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', maxItems: 2, items: { type: 'string' } } },
        },
        { items: ['a', 'b', 'c'] },
      );
      expect(errors['/data/items']).to.deep.equal({
        keyword: 'maxItems',
        instancePath: '/data/items',
        params: { limit: 2 },
        message: 'Must contain at most 2 items.',
      });
    });

    it('counts only non-empty items for maxItems (blank rows do not count)', () => {
      // Raw length is 4, but only two rows have content and the blanks prune
      // away on save — so maxItems:2 is satisfied. (If maxItems counted raw
      // length instead of content, this would wrongly fail.)
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', maxItems: 2, items: { type: 'string' } } },
        },
        { items: ['a', '', '', 'b'] },
      );
      expect(errors).to.deep.equal({});
    });

    it('counts only items for minItems (blank rows do not count toward the minimum)', () => {
      // One real item keeps the array present; the two blank rows must not push
      // it to the minimum, since they prune away on save.
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 3, items: { type: 'string' } } },
        },
        { items: ['a', '', ''] },
      );
      expect(errors['/data/items']?.keyword).to.equal('minItems');
    });

    it('counts object rows recursively: blank-object rows do not satisfy minItems', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 3,
              items: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
        { items: [{ name: 'a' }, { name: '' }, { name: '' }] },
      );
      expect(errors['/data/items']?.keyword).to.equal('minItems');
      expect(errors['/data/items']?.message).to.equal('Must contain at least 3 items with content.');
    });

    it('flags minItems once an optional array has rows, even blank ones', () => {
      // A row the author added makes the array "present", so the count
      // requirement surfaces immediately (blank rows still do not count toward
      // it). An array with no rows at all stays absent — see the optional-empty
      // tests below.
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 3, items: { type: 'string' } } },
        },
        { items: ['', '', ''] },
      );
      expect(errors['/data/items']?.keyword).to.equal('minItems');
      expect(errors['/data/items']?.message).to.equal('Must contain at least 3 items with content.');
    });

    it('validates a blank row: its required fields fire and the count shows', () => {
      // An added row is a real item — its required `name` must validate (fill it
      // or remove it), and the array shows its minItems requirement at once.
      const { errors } = setup(
        {
          type: 'object',
          properties: {
            authors: {
              type: 'array',
              minItems: 2,
              items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
            },
          },
        },
        { authors: [{ name: '' }] },
      );
      expect(errors['/data/authors']?.keyword).to.equal('minItems');
      expect(errors['/data/authors/0/name']?.keyword).to.equal('required');
    });

    it('validates a row once it carries content (nested required fires)', () => {
      // `email` gives the row content, so it survives save — now the missing
      // required `name` is a real problem and is flagged at its own pointer.
      const { errors } = setup(
        {
          type: 'object',
          properties: {
            authors: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, email: { type: 'string' } },
              },
            },
          },
        },
        { authors: [{ name: '', email: 'a@b.co' }] },
      );
      expect(errors['/data/authors/0/name']?.keyword).to.equal('required');
      expect(errors['/data/authors']).to.equal(undefined);
    });

    it('accepts object rows that carry content toward minItems', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 2,
              items: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
        { items: [{ name: 'a' }, { name: '' }, { name: 'b' }] },
      );
      expect(errors).to.deep.equal({});
    });

    it('accepts when enough items are non-empty, ignoring blank rows', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 2, items: { type: 'string' } } },
        },
        { items: ['a', '', 'b'] },
      );
      expect(errors).to.deep.equal({});
    });

    it('flags a required array whose only rows are empty (no minItems)', () => {
      const { errors } = setup(
        {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
        { items: [''] },
      );
      // A row of blanks prunes to nothing, so the array is recursively empty:
      // flagged as a missing required value, exactly like an empty `[]` array.
      expect(errors['/data/items']?.keyword).to.equal('required');
      expect(errors['/data/items']?.params?.missingProperty).to.equal('items');
      expect(errors['/data/items']?.message).to.equal('Must contain at least one item with content.');
    });
  });

  describe('form-empty values treated as absent', () => {
    it('does not fire enum for an unset optional enum field', () => {
      const { errors } = setup(
        { type: 'object', properties: { status: { type: 'string', enum: ['Active', 'Done'] } } },
        { status: '' },
      );
      expect(errors).to.deep.equal({});
    });

    it('does not fire pattern for a cleared optional string field', () => {
      const { errors } = setup(
        { type: 'object', properties: { code: { type: 'string', pattern: '^\\d+$' } } },
        { code: '   ' },
      );
      expect(errors).to.deep.equal({});
    });

    it('does not fire minLength for a cleared optional string field', () => {
      const { errors } = setup(
        { type: 'object', properties: { name: { type: 'string', minLength: 3 } } },
        { name: '' },
      );
      expect(errors).to.deep.equal({});
    });

    it('does not fire minItems for an empty optional array', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 2, items: { type: 'string' } } },
        },
        { items: [] },
      );
      expect(errors).to.deep.equal({});
    });
  });

  it('skips unsupported nodes (their values are not validated)', () => {
    const { errors } = setup(
      {
        type: 'object',
        properties: { choice: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      },
      { choice: 'anything' },
    );
    expect(errors).to.deep.equal({});
  });

  it('ignores unsupported constraint keywords (multipleOf, const, uniqueItems, exclusiveMinimum, numeric enum)', () => {
    // Only the keyword set in schema-spec.md is enforced; the compiler drops the
    // rest, so data that violates them is still valid. All values are non-empty
    // so they are actually validated for the supported keywords (type), and the
    // unsupported constraints simply do not fire.
    const { errors } = setup(
      {
        type: 'object',
        properties: {
          n: { type: 'number', multipleOf: 5, exclusiveMinimum: 0 },
          s: { type: 'string', const: 'X' },
          tags: { type: 'array', uniqueItems: true, items: { type: 'string' } },
          e: { type: 'number', enum: [1, 2] },
        },
      },
      { n: 7, s: 'Y', tags: ['x', 'x'], e: 99 },
    );
    expect(errors).to.deep.equal({});
  });

  // The guarantee: when validateDocument reports no errors, the SAVED document
  // (prune of the same data) still satisfies the schema's structural keywords.
  // This is NOT circular — prune() is independent of validateDocument, and each
  // case asserts the pruned OUTPUT against the schema keyword directly (key
  // present, array length within bounds). It locks the shared-emptiness
  // invariant: what validation accepts is exactly what survives save.
  describe('save conformance: SDK-valid data stays schema-valid after prune', () => {
    function validAndPruned(schema, data) {
      const { definition } = compileSchema(schema);
      const document = { metadata: {}, data };
      const model = buildModel({ definition, document });
      const { errors } = validateDocument({ document, model });
      return { errors, pruned: prune(data) };
    }

    it('keeps a required object key present after prune', () => {
      const schema = {
        type: 'object',
        required: ['seo'],
        properties: { seo: { type: 'object', properties: { title: { type: 'string' } } } },
      };
      const { errors, pruned } = validAndPruned(schema, { seo: { title: 'Hello' } });
      expect(errors).to.deep.equal({});
      expect(pruned).to.have.property('seo');
      expect(pruned.seo).to.deep.equal({ title: 'Hello' });
    });

    it('leaves an object-array at or above minItems after blank rows prune away', () => {
      const schema = {
        type: 'object',
        required: ['tags'],
        properties: {
          tags: {
            type: 'array',
            minItems: 2,
            items: { type: 'object', properties: { name: { type: 'string' } } },
          },
        },
      };
      // Two filled rows plus a blank one the author left behind.
      const { errors, pruned } = validAndPruned(schema, {
        tags: [{ name: 'a' }, { name: '' }, { name: 'b' }],
      });
      expect(errors).to.deep.equal({});
      expect(pruned.tags.length).to.be.at.least(2);
    });

    it('leaves an array at or below maxItems after prune', () => {
      const schema = {
        type: 'object',
        properties: { tags: { type: 'array', maxItems: 2, items: { type: 'string' } } },
      };
      const { errors, pruned } = validAndPruned(schema, { tags: ['a', '', 'b'] });
      expect(errors).to.deep.equal({});
      expect(pruned.tags.length).to.be.at.most(2);
    });
  });

  // The recursion (emptiness, presence, counting) must hold at any depth, not
  // just one level. This structure nests array → object → array → object → array
  // of strings, so errors have to be found and reported at 4-deep pointers.
  describe('deep nesting (array of objects containing a nested array of objects)', () => {
    const deepSchema = {
      type: 'object',
      properties: {
        chapters: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['heading', 'sections'],
            properties: {
              heading: { type: 'string', minLength: 2 },
              sections: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['label'],
                  properties: {
                    label: { type: 'string' },
                    keywords: { type: 'array', minItems: 2, items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    };

    it('surfaces a violation at every level of a blank nested structure', () => {
      const { errors } = setup(deepSchema, {
        chapters: [{ heading: '', sections: [{ label: '', keywords: [''] }] }],
      });
      // Optional array present-but-short -> minItems; required array recursively
      // empty -> required (both worded "items with content"); required scalars ->
      // "This field is required." — each at its own deep pointer.
      expect(errors['/data/chapters']?.keyword).to.equal('minItems');
      expect(errors['/data/chapters/0/heading']?.keyword).to.equal('required');
      expect(errors['/data/chapters/0/sections']?.keyword).to.equal('required');
      expect(errors['/data/chapters/0/sections']?.message).to.equal('Must contain at least one item with content.');
      expect(errors['/data/chapters/0/sections/0/label']?.keyword).to.equal('required');
      expect(errors['/data/chapters/0/sections/0/keywords']?.keyword).to.equal('minItems');
      expect(errors['/data/chapters/0/sections/0/keywords']?.message).to.equal('Must contain at least 2 items with content.');
    });

    it('accepts a fully-populated nested structure', () => {
      const { errors } = setup(deepSchema, {
        chapters: [{ heading: 'Intro', sections: [{ label: 'Overview', keywords: ['a', 'b'] }] }],
      });
      expect(errors).to.deep.equal({});
    });

    it('reports only the deep violation when the outer structure is valid', () => {
      // Everything is filled except the innermost array is one keyword short.
      // The error must appear at the 4-deep pointer and nothing else may fire.
      const { errors } = setup(deepSchema, {
        chapters: [{ heading: 'Intro', sections: [{ label: 'Overview', keywords: ['solo'] }] }],
      });
      expect(Object.keys(errors)).to.deep.equal(['/data/chapters/0/sections/0/keywords']);
      expect(errors['/data/chapters/0/sections/0/keywords']?.keyword).to.equal('minItems');
    });
  });
});

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
      expect(errors['/data/items']?.message).to.equal('Must contain at least one item.');
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
      expect(errors['/data/items']?.message).to.equal('Must contain at least 3 items.');
    });

    it('flags a required-field violation inside an array-root item at the field pointer', () => {
      const { errors } = setup(
        {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
        [{ name: '' }],
      );
      expect(errors['/data/0/name']?.keyword).to.equal('required');
      expect(errors['/data/0/name']?.params?.missingProperty).to.equal('name');
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
        message: 'Must contain at least 2 items.',
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

    it('counts only items for minItems (empty rows do not count)', () => {
      const { errors } = setup(
        {
          type: 'object',
          properties: { items: { type: 'array', minItems: 3, items: { type: 'string' } } },
        },
        { items: ['', '', ''] },
      );
      expect(errors['/data/items']?.keyword).to.equal('minItems');
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
});

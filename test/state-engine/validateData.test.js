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
import { validateData } from '../../src/state-engine/index.js';

describe('validateData', () => {
  it('returns valid=true and an empty errors map for a clean document', () => {
    const result = validateData({
      schema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      data: { name: 'Alice' },
    });
    expect(result.valid).to.equal(true);
    expect(result.errors).to.deep.equal({});
    expect(result.schemaIssues).to.deep.equal([]);
  });

  it('returns valid=false when data has errors', () => {
    const result = validateData({
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', title: 'Name' } },
      },
      data: {},
    });
    expect(result.valid).to.equal(false);
    expect(Object.keys(result.errors)).to.have.lengthOf.at.least(1);
  });

  it('returns valid=false when the schema itself has issues', () => {
    const result = validateData({
      schema: {
        type: 'object',
        properties: { choice: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
      },
      data: {},
    });
    expect(result.valid).to.equal(false);
    expect(result.schemaIssues.length).to.be.greaterThan(0);
  });

  it('flags missing required fields at the child pointer with missingProperty', () => {
    const result = validateData({
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', title: 'Name' } },
      },
      data: { name: '' },
    });
    expect(result.errors['/data/name']).to.deep.equal({
      keyword: 'required',
      instancePath: '/data/name',
      params: { missingProperty: 'name' },
      message: 'This field is required.',
    });
  });

  it('flags a constraint violation', () => {
    const result = validateData({
      schema: {
        type: 'object',
        properties: { name: { type: 'string', title: 'Name', minLength: 3 } },
      },
      data: { name: 'ab' },
    });
    expect(result.errors['/data/name']).to.deep.equal({
      keyword: 'minLength',
      instancePath: '/data/name',
      params: { limit: 3 },
      message: 'Must be at least 3 characters.',
    });
  });

  it('classifies schemaIssues by reason', () => {
    const result = validateData({
      schema: {
        type: 'object',
        properties: {
          choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      },
      data: {},
    });
    expect(result.schemaIssues.some((i) => i.reason === 'unsupported-composition')).to.equal(true);
  });

  it('returns valid=false with empty errors / schemaIssues for a null schema', () => {
    const result = validateData({ schema: null, data: {} });
    expect(result.valid).to.equal(false);
    expect(result.errors).to.deep.equal({});
    expect(result.schemaIssues).to.deep.equal([]);
  });

  it('treats undefined data as an empty document', () => {
    const result = validateData({
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', title: 'Name' } },
      },
    });
    expect(result.errors['/data/name']?.keyword).to.equal('required');
    expect(result.errors['/data/name']?.params?.missingProperty).to.equal('name');
  });

  it('accepts an array-root schema with an array data payload', () => {
    const result = validateData({
      schema: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            matrix: {
              type: 'array',
              items: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      data: [
        { name: 'alpha', matrix: [['a1', 'a2']] },
        { name: 'beta', matrix: [['b1']] },
      ],
    });
    expect(result.errors).to.deep.equal({});
    expect(result.schemaIssues).to.deep.equal([]);
  });

  it('flags a required-field violation inside an array-root item', () => {
    // `note` gives the row content so it survives pruning; a row of only blank
    // leaves would be treated as absent and left unvalidated.
    const result = validateData({
      schema: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, note: { type: 'string' } },
        },
      },
      data: [{ name: '', note: 'kept' }],
    });
    expect(result.errors['/data/0/name']?.keyword).to.equal('required');
    expect(result.errors['/data/0/name']?.params?.missingProperty).to.equal('name');
  });

  it('never leaks a schema location into data errors', () => {
    const result = validateData({
      schema: { type: 'object', properties: { name: { type: 'string', minLength: 3 } } },
      data: { name: 'a' },
    });
    // Data errors describe the data for the person filling it in — they must
    // not expose schema structure. schemaPath lives on schemaIssues only.
    for (const error of Object.values(result.errors)) {
      expect(error).to.not.have.property('schemaPath');
    }
  });
});

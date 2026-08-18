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
import { compileSchema } from '../../src/state-engine/schema.js';

describe('compileSchema', () => {
  describe('basic types', () => {
    it('compiles a simple object schema', () => {
      const { definition, editable } = compileSchema({
        type: 'object',
        properties: {
          name: { type: 'string', title: 'Name' },
          age: { type: 'integer' },
        },
      });

      expect(editable).to.equal(true);
      expect(definition.kind).to.equal('object');
      expect(definition.children).to.have.lengthOf(2);
      expect(definition.children[0]).to.include({ key: 'name', kind: 'string', label: 'Name' });
      expect(definition.children[1]).to.include({ key: 'age', kind: 'integer' });
    });

    it('marks fields listed in required', () => {
      const { definition } = compileSchema({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
      });
      expect(definition.children.find((c) => c.key === 'name').required).to.equal(true);
      expect(definition.children.find((c) => c.key === 'age').required).to.equal(false);
    });

    it('compiles an array with an item schema', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: {
          tags: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
        },
      });
      const tags = definition.children[0];
      expect(tags.kind).to.equal('array');
      expect(tags.minItems).to.equal(1);
      expect(tags.maxItems).to.equal(5);
      expect(tags.item.kind).to.equal('string');
    });

    it('captures enumValues for a string with enum', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { color: { type: 'string', enum: ['red', 'green'] } },
      });
      const color = definition.children[0];
      expect(color.kind).to.equal('string');
      expect(color.enumValues).to.deep.equal(['red', 'green']);
    });

    it('captures semanticType for a string with x-semantic-type', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { body: { type: 'string', 'x-semantic-type': 'long-text' } },
      });
      const body = definition.children[0];
      expect(body.kind).to.equal('string');
      expect(body.semanticType).to.equal('long-text');
    });

    it('lets enum win over x-semantic-type', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { color: { type: 'string', enum: ['red'], 'x-semantic-type': 'long-text' } },
      });
      const color = definition.children[0];
      expect(color.enumValues).to.deep.equal(['red']);
      expect(color.semanticType).to.equal(undefined);
    });

    it('ignores x-semantic-type on a non-string type', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { count: { type: 'number', 'x-semantic-type': 'long-text' } },
      });
      expect(definition.children[0].semanticType).to.equal(undefined);
    });

    it('drops an unrecognized x-semantic-type value', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { swatch: { type: 'string', 'x-semantic-type': 'color' } },
      });
      const swatch = definition.children[0];
      expect(swatch.kind).to.equal('string');
      expect(swatch.semanticType).to.equal(undefined);
    });

    ['date', 'date-time', 'time'].forEach((format) => {
      it(`captures format "${format}" on a string`, () => {
        const { definition } = compileSchema({
          type: 'object',
          properties: { when: { type: 'string', format } },
        });
        const when = definition.children[0];
        expect(when.kind).to.equal('string');
        expect(when.format).to.equal(format);
      });
    });

    it('drops an unsupported format value', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { email: { type: 'string', format: 'email' } },
      });
      expect(definition.children[0].format).to.equal(undefined);
    });

    it('ignores format on a non-string type', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { count: { type: 'number', format: 'date' } },
      });
      expect(definition.children[0].format).to.equal(undefined);
    });

    it('marks a property without an explicit type as unsupported', () => {
      const { definition, editable } = compileSchema({
        type: 'object',
        properties: { mystery: { enum: ['red', 'green'] } },
      });
      expect(definition.children[0].kind).to.equal('unsupported');
      expect(definition.children[0].unsupported.reason).to.equal('missing-type');
      expect(editable).to.equal(false);
    });

    it('marks a property with an unsupported type value as unsupported', () => {
      const { definition, editable } = compileSchema({
        type: 'object',
        properties: { x: { type: 'weird' } },
      });
      expect(definition.children[0].kind).to.equal('unsupported');
      expect(definition.children[0].unsupported.reason).to.equal('unsupported-type');
      expect(definition.children[0].unsupported.feature).to.equal('weird');
      expect(editable).to.equal(false);
    });

    it('marks a property whose type is an array as unsupported', () => {
      const { definition, editable } = compileSchema({
        type: 'object',
        properties: { x: { type: ['string', 'null'] } },
      });
      expect(definition.children[0].kind).to.equal('unsupported');
      expect(definition.children[0].unsupported.reason).to.equal('type-as-array');
      expect(editable).to.equal(false);
    });

    it('honours readOnly', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { id: { type: 'string', readOnly: true } },
      });
      expect(definition.children[0].readonly).to.equal(true);
    });

    it('picks up default values', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { name: { type: 'string', default: 'Untitled' } },
      });
      expect(definition.children[0].defaultValue).to.equal('Untitled');
    });

    it('carries description onto the node', () => {
      const { definition } = compileSchema({
        type: 'object',
        properties: { slug: { type: 'string', description: 'Lowercase, hyphen-separated.' } },
      });
      expect(definition.children[0].description).to.equal('Lowercase, hyphen-separated.');
    });
  });

  describe('$ref', () => {
    it('resolves an internal $ref', () => {
      const { definition, editable } = compileSchema({
        type: 'object',
        $defs: {
          Address: {
            type: 'object',
            properties: { street: { type: 'string' } },
          },
        },
        properties: {
          home: { $ref: '#/$defs/Address' },
        },
      });
      expect(editable).to.equal(true);
      const home = definition.children[0];
      expect(home.kind).to.equal('object');
      expect(home.children[0].key).to.equal('street');
    });

    it('terminates on cyclic refs without throwing', () => {
      const { definition } = compileSchema({
        type: 'object',
        $defs: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/$defs/Node' } },
          },
        },
        properties: { head: { $ref: '#/$defs/Node' } },
      });
      // The second-level dereference is broken intentionally; we just want no infinite loop.
      expect(definition).to.exist;
      expect(definition.kind).to.equal('object');
    });

    it('marks an external $ref as unsupported', () => {
      const { definition, editable, issues } = compileSchema({
        type: 'object',
        properties: {
          remote: { $ref: 'https://example.com/schema.json' },
        },
      });
      const remote = definition.children[0];
      expect(remote.kind).to.equal('unsupported');
      expect(remote.unsupported.reason).to.equal('external-ref');
      expect(remote.unsupported.details.ref).to.equal('https://example.com/schema.json');
      expect(editable).to.equal(false);
      expect(issues.some((i) => i.reason === 'external-ref')).to.equal(true);
    });

    it('marks a $ref that does not resolve as unsupported', () => {
      const { definition, editable, issues } = compileSchema({
        type: 'object',
        properties: {
          ghost: { $ref: '#/$defs/Missing' },
        },
      });
      const ghost = definition.children[0];
      expect(ghost.kind).to.equal('unsupported');
      expect(ghost.unsupported.reason).to.equal('unresolved-ref');
      expect(ghost.unsupported.details.ref).to.equal('#/$defs/Missing');
      expect(editable).to.equal(false);
      expect(issues.some((i) => i.reason === 'unresolved-ref')).to.equal(true);
    });
  });

  describe('compositions', () => {
    it('marks a single-entry allOf as unsupported (no composition is allowed)', () => {
      const { definition, editable, issues } = compileSchema({
        type: 'object',
        properties: {
          x: { allOf: [{ type: 'string', minLength: 3 }] },
        },
      });
      expect(editable).to.equal(false);
      expect(definition.children[0].kind).to.equal('unsupported');
      expect(issues.some((i) => i.details?.keyword === 'allOf')).to.equal(true);
    });

    it('marks a property with oneOf as unsupported; root definition still exists and editable is false', () => {
      const { definition, editable, issues } = compileSchema({
        type: 'object',
        properties: {
          x: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      });
      expect(editable).to.equal(false);
      expect(issues.some((i) => i.details?.keyword === 'oneOf')).to.equal(true);
      expect(definition).to.exist;
      expect(definition.kind).to.equal('object');
      expect(definition.children[0].kind).to.equal('unsupported');
    });

    it('marks anyOf as unsupported', () => {
      const { editable, issues } = compileSchema({
        type: 'object',
        properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
      });
      expect(editable).to.equal(false);
      expect(issues.some((i) => i.details?.keyword === 'anyOf')).to.equal(true);
    });

    it('marks multi-entry allOf as unsupported', () => {
      const { editable, issues } = compileSchema({
        type: 'object',
        properties: { x: { allOf: [{ type: 'string' }, { minLength: 3 }] } },
      });
      expect(editable).to.equal(false);
      expect(issues.some((i) => i.details?.keyword === 'allOf')).to.equal(true);
    });
  });

  describe('empty / unsupported root', () => {
    it('returns null definition for null schema', () => {
      const result = compileSchema(null);
      expect(result.definition).to.equal(null);
      expect(result.editable).to.equal(false);
    });

    it('returns an unsupported-kind definition when the root uses only unsupported composition (no properties)', () => {
      const result = compileSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] });
      expect(result.definition).to.exist;
      expect(result.definition.kind).to.equal('unsupported');
      expect(result.editable).to.equal(false);
    });

    it('compiles root as object with unsupportedComposition when allOf is present alongside properties', () => {
      const result = compileSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        allOf: [
          { required: ['name'] },
          { properties: { name: { minLength: 2 } } },
        ],
      });
      expect(result.definition.kind).to.equal('object');
      expect(result.definition.unsupportedComposition).to.deep.include({ compositionKeyword: 'allOf' });
      expect(result.definition.children).to.have.lengthOf(2);
      expect(result.editable).to.equal(false);
      expect(result.issues.some((i) => i.details?.keyword === 'allOf')).to.equal(true);
    });

    it('compiles a sub-property as object with unsupportedComposition when anyOf + properties co-exist', () => {
      const result = compileSchema({
        type: 'object',
        properties: {
          audience: {
            type: 'object',
            properties: {
              segments: { type: 'array', items: { type: 'string' } },
              regions: { type: 'array', items: { type: 'string' } },
            },
            anyOf: [{ required: ['segments'] }, { required: ['regions'] }],
          },
        },
      });
      expect(result.definition.kind).to.equal('object');
      const audience = result.definition.children[0];
      expect(audience.kind).to.equal('object');
      expect(audience.unsupportedComposition).to.deep.include({ compositionKeyword: 'anyOf' });
      expect(audience.children).to.have.lengthOf(2);
      expect(result.editable).to.equal(false);
    });

    it('marks a property as fully unsupported when oneOf has no direct properties', () => {
      const result = compileSchema({
        type: 'object',
        properties: {
          channel: {
            oneOf: [
              { type: 'object', properties: { email: { type: 'string' } } },
              { type: 'object', properties: { social: { type: 'string' } } },
            ],
          },
        },
      });
      const channel = result.definition.children[0];
      expect(channel.kind).to.equal('unsupported');
      expect(channel.unsupported.compositionKeyword).to.equal('oneOf');
    });
  });
});

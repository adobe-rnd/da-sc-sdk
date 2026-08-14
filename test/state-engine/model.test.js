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
import { buildModel, nodeAt } from '../../src/state-engine/model.js';

const objectDef = (children, extra = {}) => ({
  key: 'data', kind: 'object', label: 'Data', children, ...extra,
});

const stringDef = (key, extra = {}) => ({
  key, kind: 'string', label: key, ...extra,
});

const arrayDef = (key, item, extra = {}) => ({
  key, kind: 'array', label: key, item, ...extra,
});

describe('buildModel', () => {
  it('returns null when there is no definition', () => {
    expect(buildModel({ definition: null, document: {} })).to.equal(null);
  });

  it('builds a node tree mirroring the definition', () => {
    const def = objectDef([
      stringDef('name'),
      arrayDef('tags', stringDef('item')),
    ]);
    const model = buildModel({ definition: def, document: { data: { name: 'Alice', tags: ['x', 'y'] } } });

    expect(model.root.kind).to.equal('object');
    expect(model.root.children).to.have.lengthOf(2);
    expect(model.root.children[0]).to.include({ key: 'name', value: 'Alice', pointer: '/data/name' });
    expect(model.root.children[1].items).to.have.lengthOf(2);
    expect(model.root.children[1].items[0].pointer).to.equal('/data/tags/0');
    expect(model.root.children[1].items[1].pointer).to.equal('/data/tags/1');
  });

  it('carries description onto the built node', () => {
    const def = objectDef([stringDef('slug', { description: 'Lowercase and hyphens.' })]);
    const model = buildModel({ definition: def, document: { data: {} } });
    expect(model.root.children[0].description).to.equal('Lowercase and hyphens.');
  });

  it('populates byPointer for every node', () => {
    const def = objectDef([
      stringDef('name'),
      arrayDef('items', objectDef([stringDef('label')])),
    ]);
    const model = buildModel({
      definition: def,
      document: { data: { name: 'x', items: [{ label: 'a' }] } },
    });

    expect(nodeAt({ model, pointer: '/data' })).to.exist;
    expect(nodeAt({ model, pointer: '/data/name' })).to.exist;
    expect(nodeAt({ model, pointer: '/data/items' })).to.exist;
    expect(nodeAt({ model, pointer: '/data/items/0' })).to.exist;
    expect(nodeAt({ model, pointer: '/data/items/0/label' })).to.exist;
    expect(nodeAt({ model, pointer: '/missing' })).to.equal(null);
  });

  it('escapes special characters in pointers', () => {
    const def = objectDef([stringDef('a/b'), stringDef('c~d')]);
    const model = buildModel({ definition: def, document: { data: { 'a/b': 'x', 'c~d': 'y' } } });
    expect(nodeAt({ model, pointer: '/data/a~1b' })?.value).to.equal('x');
    expect(nodeAt({ model, pointer: '/data/c~0d' })?.value).to.equal('y');
  });

  it('surfaces semanticType from the definition on string nodes', () => {
    const def = objectDef([stringDef('body', { semanticType: 'long-text' })]);
    const model = buildModel({ definition: def, document: { data: { body: 'hi' } } });
    expect(nodeAt({ model, pointer: '/data/body' })?.semanticType).to.equal('long-text');
  });

  it('exposes itemLabel from the item definition on array nodes', () => {
    const def = objectDef([
      arrayDef('contacts', { ...objectDef([stringDef('name')]), label: 'Contact' }),
    ]);
    const model = buildModel({ definition: def, document: { data: { contacts: [{}] } } });
    expect(model.root.children[0].itemLabel).to.equal('Contact');
  });
});

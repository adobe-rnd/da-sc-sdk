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

import { appendPointer } from './pointer.js';

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) { return value; }
  return {};
}

function buildNode({
  definition, pointer, value, byPointer,
}) {
  const base = {
    key: definition.key,
    kind: definition.kind,
    pointer,
    label: definition.label,
    required: !!definition.required,
    readonly: !!definition.readonly,
    defaultValue: definition.defaultValue,
    validation: definition.validation ?? {},
    value,
  };

  if (definition.unsupported) { base.unsupported = definition.unsupported; }
  if (definition.unsupportedComposition) {
    base.unsupportedComposition = definition.unsupportedComposition;
  }
  if (Array.isArray(definition.enumValues)) { base.enumValues = definition.enumValues; }
  if (definition.semanticType) { base.semanticType = definition.semanticType; }
  if (definition.description !== undefined) { base.description = definition.description; }

  let node;

  if (definition.kind === 'object') {
    const objValue = objectValue(value);
    const children = (definition.children ?? []).map((childDef) => {
      const childPointer = appendPointer({ pointer, segment: childDef.key });
      return buildNode({
        definition: childDef,
        pointer: childPointer,
        value: objValue[childDef.key],
        byPointer,
      });
    });
    node = { ...base, children };
  } else if (definition.kind === 'array') {
    const arrValue = Array.isArray(value) ? value : [];
    const items = arrValue.map((itemValue, index) => {
      const itemPointer = appendPointer({ pointer, segment: index });
      return buildNode({
        definition: definition.item,
        pointer: itemPointer,
        value: itemValue,
        byPointer,
      });
    });

    node = {
      ...base,
      minItems: definition.minItems,
      maxItems: definition.maxItems,
      itemLabel: definition.item?.label ?? '',
      items,
    };
  } else {
    node = base;
  }

  byPointer[pointer] = node;
  return node;
}

// Contract: `document` is owned by buildModel after this call. Callers must pass
// a fresh object (mutate.js / parseDocument both deep-clone before passing in),
// otherwise their reference would alias with the model's stored document.
//
// `byPointer` is a plain object — `byPointer[pointer]` is the O(1) lookup.
// Plain object (not Map) so the state snapshot is JSON-serializable end-to-end:
// `JSON.stringify(state)` works without custom replacers, and the same shape
// reaches consumers in any runtime.
export function buildModel({ definition, document }) {
  if (!definition) { return null; }

  const normalizedDoc = document ?? {};
  const rootValue = normalizedDoc?.data ?? {};
  const byPointer = {};

  const root = buildNode({
    definition,
    pointer: '/data',
    value: rootValue,
    byPointer,
  });

  return { root, byPointer, document: normalizedDoc };
}

export function nodeAt({ model, pointer }) {
  return model?.byPointer?.[pointer] ?? null;
}

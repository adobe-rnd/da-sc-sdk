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

// The single canonical "is this value form-empty?" predicate for the SDK.
//
// Empty iff `prune()` (html/utils.js) would strip it — recursively: a container
// is empty when every leaf beneath it is (`{ a: '' }` → empty), while `0`/
// `false` are not. Must stay in lockstep with `prune()` so what validation
// accepts is exactly what save persists — the `isDataEmpty ↔ prune` symmetry
// test in test/state-engine/index.test.js guards that.
export function isDataEmpty(value) {
  if (value === null || value === undefined || value === '') { return true; }
  if (typeof value === 'string') { return value.trim() === ''; }
  if (Array.isArray(value)) { return value.length === 0 || value.every(isDataEmpty); }
  if (typeof value === 'object') {
    const entries = Object.values(value);
    return entries.length === 0 || entries.every(isDataEmpty);
  }
  return false;
}

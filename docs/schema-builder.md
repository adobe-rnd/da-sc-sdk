# SDK — Schema builder

How `compileSchema` turns a raw JSON Schema into the **compiled definition tree** that `buildModel` consumes.

> Sister docs:
> - [model-builder.md](./model-builder.md) covers what happens *after* — how the definition merges with a document to produce the model.
> - [lifecycle.md](./lifecycle.md) shows where this step fits in the end-to-end call flow.
>
> This doc covers everything *before* the model exists.

---

## 1. Why compile a schema at all

The renderer doesn't want to interpret JSON Schema. It wants a flat, predictable tree of *fields*: each field has a kind, a label, validation rules, optional children/items, and nothing else. A JSON Schema as authored is too rich for that:

- It carries `$ref` indirection, `$defs` reuse, and composition keywords (`allOf` / `oneOf` / `anyOf`).
- Nodes carry both supported and unsupported keywords mixed together.
- `type` can technically be an array (`["string", "null"]`) — not in our spec, but real input may contain it.

`compileSchema` is the **resolver + normalizer**: it walks the raw schema once, resolves `$ref`s, flags unsupported constructs as first-class issues, and emits a single homogeneous definition tree. After this step nothing downstream needs to know about `$ref`, `allOf`, etc.

```
rawSchema ──▶ compileSchema ──▶ { schema, definition, editable, issues }
                                    └─▶ definition feeds buildModel
                                    └─▶ issues feed the schema-issues panel
```

The compiler also exposes the *resolved* schema (`schema` in the return value) for tools that want the fully-dereferenced JSON Schema without the form's internal kind/definition layer.

---

## 2. Public surface

`compileSchema(rawSchema)` from [state-engine/schema.js](../src/state-engine/schema.js).

| Input | Type |
|---|---|
| `rawSchema` | A JSON Schema object as authored, or `null` / non-object |

Returns:

```js
{
  schema,      // fully-resolved JSON Schema ($refs inlined, $defs unused). null if rawSchema was invalid.
  definition,  // compiled definition tree — input to buildModel
  editable,    // boolean: true when no issues were collected
  issues,      // array of { reason, message, schemaPath, pointer, details } — see §6
}
```

The contract:

- **Pure.** Same input → same output. No state.
- **Idempotent under repeat compilation.** Re-compiling the resolved schema yields the same definition (refs are already inlined).
- **Never throws on malformed input.** Issues are *collected* into the `issues` array rather than raised; the form renders the editable subset and surfaces issues in a side panel.

---

## 3. Two phases

The compiler is two passes, in order:

```
compileSchema
  ├─ resolveSchema(rawSchema)
  │    └─ resolveNode(...)                ← phase 1: refs + composition flagging
  └─ compileNode(...)                     ← phase 2: kind inference + tree shaping
```

### Phase 1 — `resolveSchema` / `resolveNode`

Walks the raw schema. At each node:

1. **Deep-clones** the input (the resolved schema owns its own object graph; callers can mutate `rawSchema` later without affecting compiled output).
2. **Resolves `$ref`.**
   - External refs (anything not starting with `#/`) become `unsupportedRef: { reason: 'external-ref', ref }`.
   - Internal refs that don't resolve become `unsupportedRef: { reason: 'unresolved-ref', ref }`.
   - Cycles are broken by tracking refs in `seenRefs`; the cycle root keeps whatever local fields it already had.
   - Successful refs are merged with the local node via `mergeSchemas` — local fields take precedence over the referent's fields. `properties` and `$defs` are merged shallowly; `required` is union-merged.
3. **Flags composition keywords.** `allOf` / `oneOf` / `anyOf` are all unsupported (see [schema-spec.md](./schema-spec.md)). If the node also has direct `properties`, the node is **marked with `unsupportedComposition`** and recursion continues so the editable subset still renders. If there are no direct properties, the node becomes wholly unsupported.
4. **Recurses** into `items` (for arrays) and `properties` (for objects), with the schema path tracked for issue reporting.

Output of phase 1: the raw schema, but with `$ref` inlined, composition keywords stripped (or flagged), and unsupported branches marked via `unsupportedRef` / `unsupportedComposition`.

### Phase 2 — `compileNode`

Walks the resolved schema. At each node:

1. **Infers the kind** via `inferKind`. Order matters:
   - `unsupportedRef` → `kind: 'unsupported'`
   - `unsupportedComposition` with direct `properties` → `kind: 'object'` (composition surfaces as a flag on the object node)
   - `unsupportedComposition` without direct `properties` → `kind: 'unsupported'`
   - `type` as array (`["string", "null"]`) → `kind: 'unsupported'`
   - `type` string in `SUPPORTED_TYPES` → that kind
   - Anything else (missing type, unknown type) → `kind: 'unsupported'`
2. **Picks validation rules** via `pickValidation`. Only `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` survive — everything else is silently dropped. This is intentional: the validator's contract is the docs, not the JSON Schema spec.
3. **Builds the node** with `key`, `kind`, `label` (from `title` or key fallback), `description` (from `description`, when set), `required`, `readonly`, `defaultValue`, `validation`.
4. **Recurses** for composite kinds:
   - `object` → compiles each `properties` entry into `children`. `required` flags carry through.
   - `array` → compiles `items` into a single `item` node (the *template* for array elements; the model later instantiates one node per document element).
5. **Collects issues** into the shared `issues` array. Each issue records its `reason`, a human `message`, both locations (`schemaPath` in the schema, `pointer` in the data), and a reason-specific `details` blob.

Output of phase 2: the **definition tree**.

---

## 4. The definition tree

What `compileNode` produces. This is the shape `buildModel` expects.

```js
{
  key,                     // schema property key, or 'data' at the root
  kind,                    // 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unsupported'
  label,                   // schema.title or key fallback
  required,
  readonly,
  defaultValue,            // from schema.default
  validation,              // { minLength?, maxLength?, pattern?, minimum?, maximum? }

  // object:
  children:    [...],
  unsupportedComposition?: { compositionKeyword, variants, schemaPath },

  // array:
  item:        { … definition node … },
  minItems, maxItems,

  // primitive with enum:
  enumValues:  [...],

  // unsupported:
  unsupported: { reason, feature, compositionKeyword, variants, schemaPath, details },
}
```

Two important differences from the **model** node shape (see [model-builder.md §3](./model-builder.md)):

- **No `pointer` and no `value`.** Those exist in the model, not the definition. The definition is *static* — it describes the schema. The model is *dynamic* — it pairs the definition with a document.
- **`array` carries a single `item`, not `items`.** `item` is the template for each element. When the model builds, it instantiates one node from this template per element in the document array.

---

## 5. Worked examples

Each example shows the raw schema and the compiled definition. Some boilerplate fields (`required: false`, `readonly: false`, empty `validation: {}`) are elided.

### 5.1. Simple primitives

```js
// raw schema
{
  type: 'object',
  title: 'Profile',
  required: ['name'],
  properties: {
    name: { type: 'string', title: 'Name', minLength: 1 },
    age:  { type: 'integer', title: 'Age',  minimum: 0 },
  },
}
```

```js
// definition
{
  key: 'data',
  kind: 'object',
  label: 'Profile',
  children: [
    {
      key: 'name', kind: 'string', label: 'Name',
      required: true,
      validation: { minLength: 1 },
    },
    {
      key: 'age', kind: 'integer', label: 'Age',
      validation: { minimum: 0 },
    },
  ],
}
```

Note that only the picked validation keywords appear on the leaf — `type` and `title` have been absorbed into `kind` and `label`.

### 5.2. Enum

```js
// raw schema
{ type: 'string', title: 'Color', enum: ['red', 'blue'] }
```

```js
// definition
{ key: 'data', kind: 'string', label: 'Color', enumValues: ['red', 'blue'] }
```

The `enumValues` field is the trigger that makes the renderer pick a `<select>`. The kind stays `'string'` (or whatever the underlying type is) — `enum` is decoration, not its own kind.

### 5.3. Array

```js
// raw schema
{
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      title: 'Tags',
      minItems: 1,
      items: { type: 'string', title: 'Tag' },
    },
  },
}
```

```js
// definition
{
  key: 'data', kind: 'object',
  children: [
    {
      key: 'tags', kind: 'array', label: 'Tags',
      minItems: 1, maxItems: undefined,
      item: {
        key: 'item', kind: 'string', label: 'Tag',
      },
    },
  ],
}
```

`item` is a single node — the template. The model later replicates it per array element.

### 5.4. `$ref` and `$defs`

```js
// raw schema
{
  type: 'object',
  $defs: {
    Address: {
      type: 'object',
      title: 'Address',
      properties: { street: { type: 'string', title: 'Street' } },
    },
  },
  properties: {
    home: { $ref: '#/$defs/Address' },
    work: { $ref: '#/$defs/Address', title: 'Work address' },
  },
}
```

```js
// definition (refs inlined; local 'title' on 'work' wins via mergeSchemas)
{
  key: 'data', kind: 'object',
  children: [
    {
      key: 'home', kind: 'object', label: 'Address',
      children: [{ key: 'street', kind: 'string', label: 'Street' }],
    },
    {
      key: 'work', kind: 'object', label: 'Work address',
      children: [{ key: 'street', kind: 'string', label: 'Street' }],
    },
  ],
}
```

After compilation, `$ref` and `$defs` are gone. The two `Address` instances are independent object graphs — mutating one does not affect the other.

### 5.5. Cyclic `$ref`

```js
// raw schema
{
  type: 'object',
  $defs: {
    Node: {
      type: 'object', title: 'Node',
      properties: {
        name:     { type: 'string', title: 'Name' },
        children: { type: 'array', title: 'Children', items: { $ref: '#/$defs/Node' } },
      },
    },
  },
  $ref: '#/$defs/Node',
}
```

The cycle is detected when the recursion revisits `#/$defs/Node`. The inner recursion keeps whatever local fields it already had (here, none beyond the cycle) and stops. The outer levels compile normally. The cycle root is reachable but its inner `children.items` becomes a degenerate object node with no recursive children.

In practice, **avoid cyclic schemas.** The form has no UI for unbounded recursion. The compiler tolerates a cycle without crashing; it does not unfold it.

### 5.6. Composition flagged as unsupported

```js
// raw schema
{
  type: 'object',
  properties: {
    weird: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
}
```

```js
// definition.children[0]
{
  key: 'weird',
  kind: 'unsupported',
  unsupported: {
    reason: 'unsupported-composition',
    feature: 'oneOf',
    compositionKeyword: 'oneOf',
    variants: 2,
    schemaPath: '/',
    details: null,
  },
}

// compileSchema(...).issues
[
  {
    reason: 'unsupported-composition',
    message: 'Composition "oneOf" is not supported.',
    schemaPath: '/properties/weird',
    pointer: '/data/weird',
    details: { keyword: 'oneOf', variants: 2 },
  },
]
```

The editor skips rendering this field; the schema-issues dialog lists the issue. `compileSchema(...).editable` is `false`.

### 5.7. Composition alongside `properties` (partial render)

```js
// raw schema
{
  type: 'object',
  title: 'Mixed',
  allOf: [{ properties: { extra: { type: 'string' } } }],
  properties: {
    name: { type: 'string', title: 'Name' },
  },
}
```

```js
// definition
{
  key: 'data', kind: 'object', label: 'Mixed',
  unsupportedComposition: { compositionKeyword: 'allOf', variants: 1, schemaPath: '/' },
  children: [
    { key: 'name', kind: 'string', label: 'Name' },
  ],
}
```

The object compiles and the editable subset (`name`) renders. The `allOf` is dropped from the definition but recorded as an issue and as a flag on the object node — the schema-issues panel surfaces it, and the renderer can choose to badge the section.

`extra` from the `allOf` branch is **not** merged into `children`. The compiler's policy is "render the directly-defined editable subset, surface everything else as an issue" — not "salvage what you can from inside the unsupported keyword."

### 5.8. External / unresolved `$ref`

```js
// raw schema
{ type: 'object', properties: { x: { $ref: 'https://example.com/foo.json' } } }
```

```js
// definition.children[0]
{
  key: 'x',
  kind: 'unsupported',
  unsupported: {
    reason: 'external-ref',
    feature: 'external-ref',
    compositionKeyword: 'external-ref',
    details: { ref: 'https://example.com/foo.json' },
  },
}
```

Same shape for `unresolved-ref` (an internal `#/` pointer that doesn't resolve). Both flow through the unsupported pathway.

---

## 6. Issue collection

Issues populate `compileSchema(...).issues` and drive both:

- `state.schemaIssues` (the array exposed via `getState()`), and
- the schema-issues panel in the editor UI.

```js
{
  reason,      // machine code: 'unsupported-composition' | 'unsupported-type' |
               //   'type-as-array' | 'missing-type' | 'external-ref' |
               //   'unresolved-ref' | 'invalid-pattern' — branch on this
  message,     // human-readable summary, derived from reason/details
  schemaPath,  // '/properties/weird' — where to fix it in the *schema* ($refs
               //   re-rooted at their $def); '/' at the root
  pointer,     // '/data/weird' — where it manifests in the *data* (canonical addressing)
  details,     // structured, reason-specific context, or null:
               //   { type }            — unsupported-type / type-as-array
               //   { keyword, variants }— unsupported-composition
               //   { ref }             — external-ref / unresolved-ref
               //   { pattern }         — invalid-pattern
}
```

The compiler does **not** sort or deduplicate; issues appear in traversal order. Consumers that want a stable display order should sort by `pointer` (or `schemaPath`). A shared `$def` referenced from several places yields one entry per usage — dedupe on `schemaPath` to collapse them.

`editable` is `issues.length === 0`. Any single issue marks the schema as non-editable — `createEngine` still produces an engine and `getState()` returns a populated model, but consumers typically display a "schema has issues" banner over (or instead of) the editor UI.

---

## 7. How `compileSchema` is invoked

| Call site | Purpose |
|---|---|
| `createEngine({ schema, document, onChange })` | Each engine creation compiles its schema. The compiled definition lives in a closure variable for the engine's lifetime and feeds every `buildModel` call. |
| `validateData({ schema, data })` | One-shot validation. Compiles, builds a throwaway model, runs validation, returns `{ valid, errors, schemaIssues }`. No state. |
| External tools (MCP, codegen) | `compileSchema` is part of the headless API. See [headless-consumer.md](./headless-consumer.md). |

Compilation is one-shot per engine — it is *not* on the keystroke hot path. Compilation cost is bounded by schema size, which is small in practice.

---

## 8. Invariants worth knowing

- **The compiler never throws.** Every malformed input produces a definition and a list of issues. If you find a crash, that's a bug in the compiler.
- **Issues are advisory, not blocking.** A document with `editable: false` still loads; it just paints the schema-issues panel. Mutations may be blocked by individual node `readonly` flags but not by `editable === false` globally.
- **External-fetching `$ref`s are forbidden.** The compiler only resolves same-document `#/...` pointers. Anything else is an `unsupported-ref` issue. The form is offline-safe by construction.
- **Validation keywords are an allowlist.** Only `minLength`, `maxLength`, `pattern`, `minimum`, `maximum` survive into the definition. If the spec adds new keywords (e.g. `multipleOf`), they need to be added explicitly to `RULE_NAMES` *and* to `validation.js`.
- **`title` is the label.** If `title` is missing, the property key is used. There is no smart casing. The spec ([schema-spec.md R4](./schema-spec.md)) requires authors to set `title`.
- **`$defs` reuse is fully inlined.** Two `$ref`s to the same `$defs` entry produce two independent definition subtrees. Downstream consumers cannot detect that they came from the same source.

---

## 9. Adding a new field kind

When the spec gains a new type, three places in the compiler need to update:

1. **`SUPPORTED_TYPES`** at [state-engine/schema.js](../src/state-engine/schema.js) — add the new type string.
2. **`inferKind`** — return `{ kind: '<new>' }` for the new type. The default `SUPPORTED_TYPES.has(...)` branch already handles primitive kinds; only add a special case if your new kind needs structural recursion (like `object`/`array`).
3. **`compileNode`** — if the new kind has recursive children or extra metadata (similar to `properties`/`items`/`minItems`), add a branch that builds the node accordingly.

Then update the model builder, the renderer, the validator, and `coerceData` per [model-builder.md §7](./model-builder.md).

If your new "kind" is actually a *decoration* on an existing kind (like `enum` on `string`), do not introduce a new kind. Add a new field on the existing kind's node (like `enumValues`) and trigger off it in the renderer.

---

## 10. What the compiler does *not* do

A few things the compiler deliberately leaves to other modules — useful to know when debugging:

- **Type coercion of values.** Compilation has nothing to do with the document. See `coerceData` in [state-engine/index.js](../src/state-engine/index.js) and [architecture.md §13](./architecture.md).
- **Defaults materialization.** The compiler captures `default` per node but does not write it into any document. `materializeDefaults` runs at load time when the document is empty.
- **Validation execution.** The compiler picks *which* validation rules survive, not whether a value satisfies them. That happens in [state-engine/validation.js](../src/state-engine/validation.js).
- **Rendering decisions.** The compiler produces `kind` and `enumValues`; the renderer in [views/editor.js](../views/editor.js) decides what HTML to emit for each kind. There is no compiler-side renderer hint beyond `kind` and `enumValues`.

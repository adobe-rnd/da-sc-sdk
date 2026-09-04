# da-sc-sdk — Architecture

Headless engine for editing structured-content documents against a JSON Schema. Owns canonical state, mutation, validation, and HTML wire-format conversion. No DOM, no UI, no network — those concerns live in the consuming application.

Related reading:
- [lifecycle.md](./lifecycle.md) — the synchronous call flow inside each public function (createEngine, mutations, validate, convert).
- [schema-builder.md](./schema-builder.md) — `compileSchema` deep dive.
- [model-builder.md](./model-builder.md) — `buildModel` deep dive.
- [schema-spec.md](./schema-spec.md) — the per-keyword contract for what the SDK accepts.
- [headless-consumer.md](./headless-consumer.md) — worked example of a non-browser consumer.

---

## 1. Layout

```txt
da-sc-sdk/
  src/
    index.js          curated public re-exports
    state-engine/             headless editing engine
      index.js          createEngine() — public API; validateData, isDataEmpty, materializeDefaults, coerceData
      schema.js         resolveSchema + compileSchema ($ref/$defs resolution, composition handling)
      model.js          buildModel + pointer→node Map, in one pass
      mutate.js         setField, addItem, insertItem, removeItem, moveItem
      pointer.js        RFC 6901 ops + definitionAt
      validation.js     validateDocument → { errors } (pointer-keyed map)
      clone.js          single deepClone util
    html/             DA wire-format HTML ↔ JSON
      html2json.js      parse DA HTML → JSON; HTMLConverter class + convertHtmlToJson({ html })
      json2html.js      emit JSON → DA HTML; defines convertJsonToHtml (public) + json2html (internal raw)
      utils.js          prune helper shared by the emit path
  dist/
    index.js          self-contained ESM bundle for vendor / CDN consumers
  test/               mirrors src/ — one .test.js per module + roundtrip suite
```

---

## 2. Dependency direction

```txt
src/html/   →  (no SDK-internal deps; uses hast-util-from-html (parse5-based) for parsing; no DOM for emit)
src/state-engine/   →  (zero external imports — only relative ./)
src/index.js → src/state-engine/, src/html/
```

`state-engine/` has no DOM, no Lit, no browser dependency. It runs unchanged in Node, browsers, MCP servers, and any other ESM runtime. The boundary is enforced by zero external imports — there is nothing in `state-engine/` for a build tool to fail to resolve.

`html/` is environment-agnostic. The `JSON → HTML` direction in [src/html/json2html.js](../src/html/json2html.js) is a pure string builder — template literals + a small text/attribute escape helper. No DOM, no async, no peer dependency. The `HTML → JSON` direction uses `hast-util-from-html`, a pure-JS parse5 wrapper with no DOM or Node-built-in dependency. The whole SDK runs in Cloudflare Workers, Deno, Bun, and other V8-isolate environments without modification.

---

## 3. API

```js
const engine = createEngine({ schema, document, onChange }); // sync; fully initialized
const state = engine.setField(pointer, value);                // sync
const state = engine.addItem(pointer);                        // sync
const state = engine.insertItem(pointer);                     // sync — insert before this pointer
const state = engine.removeItem(pointer);                     // sync
const state = engine.moveItem(pointer, fromIndex, toIndex);   // sync
const state = engine.getState();
```

`createEngine` runs all initialization synchronously (compile schema, build model, validate) and returns a fully-initialized engine. All mutations are synchronous. `onChange` is invoked after every state transition triggered by a mutation — NOT at construction. The engine has exactly one onChange slot — consumers that need to fan out to multiple observers (e.g. UI re-render + persistence) do so inside their onChange handler. To start over with a different `(schema, document)` pair, create a new engine.

### State snapshot

What `getState()` and `onChange` callers see. Plain JSON — no methods, no proxies, safe to `JSON.stringify` and replay.

```js
state = {
  document:    { values },                 // the current doc shape
  model:       { root, byPointer, document } | null,
  validation:  {
    errors: { [instancePath]: { keyword, instancePath, params, message }, ... },
  },
  schemaIssues: [{ reason, message, schemaPath, pointer, details }, ...],
}
```

`validation.errors` is a pointer-keyed map. One canonical view:

- UI consumers do `errors[pointer]?.message` — O(1) lookup, no scanning.
- Agents iterate via `Object.values(errors)`.

Per-entry shape (the values in the map) is ajv-style: `{ keyword, instancePath, params, message }`. See §8 for the full per-keyword reference. UI code renders `.message`; agents branch on `.keyword` and read `.params` for context.

Note: there is no `saveStatus` field. The engine doesn't persist; consumers that do maintain their own status outside the engine.

### Public API — five exports

The SDK exposes exactly five named exports from `'da-sc-sdk'`. The surface is narrow on purpose; additions go through deliberate semver minors.

| Function | Source | Purpose |
| -------- | ------ | ------- |
| `createEngine({ schema, document, onChange })` | [src/state-engine/index.js](../src/state-engine/index.js) | Stateful JSON state engine — initialized synchronously, exposes mutations and validation. Returns `{ getState, setField, addItem, insertItem, removeItem, moveItem }`. Pure state machine: no persistence, no I/O. `onChange` is NOT called at construction; initial state is read via `engine.getState()`. To swap (schema, document), create a new engine. |
| `validateSchema({ schema })` | [src/state-engine/index.js](../src/state-engine/index.js) | Schema-only validation. Returns `{ valid, schemaIssues }`. Use to check that a schema is well-formed before binding to it. |
| `validateData({ schema, data })` | [src/state-engine/index.js](../src/state-engine/index.js) | Data-against-schema validation. Returns `{ valid, errors, schemaIssues }`. `errors` is a pointer-keyed map of ajv-style entries. `valid` is `true` iff both `schemaIssues` and `errors` are empty. Symmetric with `validateSchema`: both validators expose `valid` + `schemaIssues`; `validateData` adds `errors`. |
| `convertJsonToHtml({ json })` | [src/html/json2html.js](../src/html/json2html.js) | JSON → DA wire-format HTML. Prunes empty/null/whitespace leaves before emitting (same shape the engine would save). Pure string builder, no DOM. Returns `{ html } \| { error }`. |
| `convertHtmlToJson({ html })` | [src/html/html2json.js](../src/html/html2json.js) | DA wire-format HTML → JSON. Returns `{ json } \| { error }` so a malformed input produces a clear reason instead of a silent null. |

### Everything else is internal — and unreachable

`src/state-engine/pointer.js`, `src/state-engine/mutate.js`, `src/state-engine/model.js`, `src/state-engine/clone.js`, `src/state-engine/validation.js`, `src/state-engine/schema.js`, `src/html/json2html.js`, plus the `compileSchema` / `coerceData` / `materializeDefaults` / `isDataEmpty` / `HTMLConverter` symbols inside them — all internal.

The `package.json` `exports` map exposes only `.` (the main entry). Per the Node ESM spec, this **blocks every other subpath** — a consumer attempting `import x from 'da-sc-sdk/src/state-engine/schema.js'` gets `ERR_PACKAGE_PATH_NOT_EXPORTED`. The vendored bundle (`dist/index.js`) only re-exports the five public functions. There is no path-based escape hatch.

The only code that reaches internals is the SDK's own tests via relative paths into `src/` — that's white-box testing, not API consumption.

The schema contract that bounds what schemas the SDK accepts is in [schema-spec.md](./schema-spec.md).

---

## 4. Runtime model

`buildModel({ definition, document })` produces:

```js
{
  root,        // node tree
  byPointer,   // { [pointer]: node } — plain object so the whole state is JSON-serializable
  document,    // normalized doc
}
```

Nodes:

```js
{
  key,
  kind,                    // 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'unsupported'
  pointer,                 // RFC 6901
  label,
  description?,            // schema.description help text, when set
  required, readonly,
  value,                   // current value from document
  defaultValue,            // schema default
  validation,              // picked subset: minLength, maxLength, pattern, minimum, maximum
  enumValues?,             // when present, consumer should render a select
  format?,                 // 'date' | 'time' | 'date-time' — render a date/time control
  // object:      children: [...], unsupportedComposition?: { compositionKeyword, variants, schemaPath }
  // array:       items: [...], minItems, maxItems, itemLabel
  // unsupported: unsupported: { reason, feature, compositionKeyword, variants, schemaPath }
}
```

`unsupportedComposition` on an object node means the schema used a composition keyword (`allOf`, `oneOf`, `anyOf`) alongside direct `properties`. The properties are compiled normally; the composition itself becomes an entry on `state.schemaIssues`. The node remains editable.

A `kind: 'unsupported'` node means the field's shape is defined by a construct the SDK cannot model (composition with no sibling properties, an unknown `type`, `type` as an array, or a missing `type`). Consumers should skip rendering these nodes; stored values pass through untouched.

The pointer→node Map is built during the same traversal that builds the tree — no follow-up pass.

When adding a new field type, add a new `kind` value to `schema.js`'s `inferKind`. Never fall through to a default.

---

## 5. Persistence — explicitly out of scope

The engine does not persist. It has no `save` callback, no `saveStatus` field, no network code. This is intentional:

- Different consumers want different persistence semantics — single-flight, batched, transactional, offline-queued, optimistic-with-rollback.
- Persistence orchestration is a distributed-systems problem that doesn't belong in the engine's state machine.
- The SDK stays trivially testable: no I/O to mock.

### How consumers persist

React to `onChange`. On each notification, decide whether and how to save:

```js
let engine;
let lastValues;

engine = createEngine({
  schema,
  document,
  onChange: () => {
    const next = engine.getState().document;
    if (next === lastValues) return;     // non-mutation change (e.g. validation refresh)
    lastValues = next;
    // ...your save here...
  },
});
// onChange doesn't fire at init — capture the initial reference manually.
lastValues = engine.getState().document;
```

Detecting mutations: every real mutation produces a new `document` reference (mutate.js deep-clones). Non-mutation transitions keep the same reference. Reference comparison is sufficient.

### Reference pattern

A typical consumer-side persistence layer exposes a `notify()` method that the consumer's `onChange` calls; on each notification, the layer compares `document` to the last captured reference, ignores no-ops, and runs single-flight save with re-queue. Fits in ~40 lines and stays outside the SDK so each consumer can pick its own save semantics.

If a consumer needs different semantics (bulk save, atomic multi-doc, offline queue, optimistic rollback), they write their own version. The engine doesn't care — it just calls `onChange`.

---

## 6. Arrays

JSON Pointer is positional, so pointers change when items move. Pointers are the sole address for fields. Array-item rendering uses positional diffing — there is no separate stable id.

---

## 7. Schema features

The SDK applies two independent contracts to a schema:

- **Compiler editability** — `schema.js` + `model.js` decide what the SDK can *render and edit*. This is an allowlist: an unsupported construct produces a `kind: 'unsupported'` node (or an `unsupportedComposition` flag on a still-editable object).
- **Validator correctness** — `validation.js` enforces only the keywords listed in [schema-spec.md](./schema-spec.md). It walks the model; any keyword outside the allowlist is silently ignored. The contract is the documentation, not the JSON Schema spec.

The schema-spec also defines **authoring rules** (property key pattern, reserved keys `metadata` / `section-metadata`) that the runtime does not police. Authors and code generators are expected to follow them; behavior on violation is undefined.

Compiler resolution (in `schema.js`):

- `$ref` — internal refs only (`#/...`). External or unresolved refs produce an unsupported node.
- `type` must be one of `string` / `number` / `integer` / `boolean` / `object` / `array`. Anything else produces an unsupported node.

When an unsupported construct is found on a node:

- **Node has direct `properties`** (composition alongside a full property map): compiled as `kind: 'object'` with an `unsupportedComposition` flag. Properties are fully editable.
- **Otherwise**: compiled as `kind: 'unsupported'`. The stored value passes through untouched.

`compileSchema` returns `{ schema, definition, editable, issues }`. `issues` lists every node the compiler could not model with structured reason codes (`unsupported-composition`, `unsupported-type`, `type-as-array`, `missing-type`, `external-ref`, `unresolved-ref`); `editable` is `false` iff `issues` is non-empty. `issues` is also exposed on every state snapshot as `state.schemaIssues`.

---

## 8. Validation

### Output

The engine exposes validation on every state snapshot:

```js
state.validation = {
  errors: {
    '/data/name': {
      keyword: 'minLength',
      instancePath: '/data/name',
      params: { limit: 3 },
      message: 'Must be at least 3 characters.',
    },
    '/data/items/0/age': {
      keyword: 'required',
      instancePath: '/data/items/0/age',
      params: { missingProperty: 'age' },
      message: 'This field is required.',
    },
    // ...
  },
}
```

`errors` is a plain object keyed by `instancePath`. UIs do `errors[pointer]?.message` (O(1)). Agents iterate via `Object.values(errors)`. One canonical view — no parallel array, no duplication.

Per-entry shape mirrors ajv with three deliberate deviations:

1. **Outer container is a pointer-keyed map, not an array.** ajv returns `errors: [...]`. We return `errors: { [pointer]: ... }` so UI consumers get direct lookup and agents still iterate trivially with `Object.values`.
2. **`schemaPath` is excluded.** See "What errors don't expose" below.
3. **`required` errors land on the child pointer** — the SDK puts `instancePath` at the field that's missing, not the parent object. ajv does the opposite. See the per-keyword table for why.

One error per pointer by design (see the Pipeline section below): the first failing check per node wins. `instancePath` is duplicated inside each entry (matching ajv's per-entry shape) so iteration via `Object.values` yields self-describing records.

`instancePath` is an RFC 6901 JSON Pointer into the form data, rooted at
`/data` (the document shape is `{ metadata, data }`; `metadata` is not
validated). This is why `metadata` and `section-metadata` are reserved
property keys in [schema-spec.md](./schema-spec.md) — a schema cannot define
a field that would collide with the runtime document shape.

### Error shape

Every entry in `errors` is an object:

| Field | Type | Notes |
|---|---|---|
| `keyword` | string | The JSON Schema keyword that failed. Stable vocabulary — same names ajv uses (`minLength`, `pattern`, `enum`, `required`, `type`, `minimum`, `maximum`, `minItems`, `maxItems`). |
| `instancePath` | string | RFC 6901 pointer into the data. `''` for the whole instance; otherwise rooted at `/data`. |
| `params` | object | Keyword-specific structured info — see per-keyword table below. |
| `message` | string | Human-readable sentence — capitalized, period-terminated, no shouty caps. UI consumers render this directly. |

UI consumers read `.message` (one line, no branching). Agents and programmatic consumers branch on `.keyword` and use `.params` to construct a fix.

The full per-keyword reference:

| `keyword` | When emitted | `instancePath` | `params` |
|---|---|---|---|
| `required` | object child is `required` and form-empty | pointer to the **child** (where the missing field would be) | `{ missingProperty: '<childKey>' }` |
| `required` | document has no `data` key | `/data` | `{ missingProperty: 'data' }` |
| `type` | value's type does not match `kind` | pointer to the value | `{ type: 'string' \| 'number' \| 'integer' \| 'boolean' \| 'array' }` |
| `enum` | value not in `enumValues` | pointer to the value | `{ allowedValues: [...] }` |
| `minLength` / `maxLength` | string length out of range | pointer to the value | `{ limit: <n> }` |
| `pattern` | string fails the regex | pointer to the value | `{ pattern: '<regex source>' }` |
| `format` | `date`/`time`/`date-time` value has an invalid shape or value | pointer to the value | `{ format: 'date' \| 'time' \| 'date-time' }` |
| `minimum` / `maximum` | number out of range | pointer to the value | `{ limit: <n> }` |
| `minItems` / `maxItems` | non-empty item count out of range (blank items don't count) | pointer to the value | `{ limit: <n> }` |

New keywords (or new `params` fields on existing keywords) may be added in minor releases. Existing keywords and field names are stable.

#### Why `required` lives on the child (deviation from ajv)

ajv emits `required` errors at the *parent's* pointer because, strictly, a missing key has no pointer in the data. We deliberately diverge: the SDK puts `instancePath` at the field that's missing, with `params.missingProperty` still set for ajv-recognizability.

The reason: consumers need that pointer.

- **UI consumers** can render the error next to the field with a flat lookup — `errors.find(e => e.instancePath === pointer)?.message` is one line, no parent arithmetic, no pointer-segment unescaping.
- **Agents** can act on the error directly — `setField(error.instancePath, ...)` works without composing parent + missingProperty first.

Pointer construction stays inside the SDK; consumers never do it. The child-pointer + `missingProperty` combination preserves all the ajv-recognizable structure an agent uses to branch on the error type.

### What errors don't expose

The SDK deliberately omits two ajv-standard fields:

- **`schemaPath`** — would expose schema structure (property names, nesting, `$defs` layout) to whoever sees the errors. Our consumers (form UI, MCP agents, workers) don't need it; tools that forward errors externally shouldn't be tempted to leak it. If you need it, you have the schema.
- **`data`** — ajv's optional verbose mode adds the offending raw value to each error. We never include it; the offender is at `instancePath` in the source data.

Consumers that forward errors across a trust boundary (worker → untrusted client) should consider stripping `params.pattern` and `params.allowedValues` too — both reveal schema details. The SDK gives you the data; the privacy policy is yours.

### When it runs

`validateDocument` is called inside `rebuildModel` — i.e. after `load` and after every mutation. Validation is part of the same synchronous transition that produces the new state snapshot; consumers never see a model without matching errors. There is no async or debounced validation.

### Scope

The validator enforces only the keywords listed in [schema-spec.md](./schema-spec.md): `required`, `enum`, `minLength`, `maxLength`, `pattern` on strings; `minimum`, `maximum` on numbers and integers (plus integer-ness for `kind: 'integer'`); `minItems`, `maxItems` on arrays. Anything outside that allowlist is ignored — the contract is the documentation, not the JSON Schema spec.

### Pipeline

`validateDocument({ document, model })` walks the model once. For each node:

1. If `kind === 'unsupported'`, skip — the SDK doesn't render these and the document value passes through unvalidated.
2. If the value is form-empty, skip constraint checks on this node.
3. Otherwise dispatch by `kind` and apply the per-keyword checks. The first error per node wins.
4. For object nodes, after step 3, iterate children: for each `required` child whose value is form-empty, emit a `required` error at the parent's pointer.

Keywords and messages are owned by `validation.js` and stable across edits — see the table above.

### Invalid `pattern` is a schema issue, not a data error

ajv throws at schema-compile time when the pattern's regex is unparseable. We mirror that: `schema.js` calls `new RegExp(pattern)` during compile; on failure it pushes `{ reason: 'invalid-pattern', details: { pattern } }` to `schemaIssues` and drops the pattern from the node's validation. The data validator never tries to use an invalid pattern. Pre-flight the schema with `validateSchema()` and surface `invalid-pattern` issues to the schema author.

### Form-empty values

`mutate.js`'s `buildDefault` seeds new array items with `""` / `false` / `[]` / `{}` so consumers have something to bind to. These are not real user values:

- Empty string, whitespace-only string, empty array, empty object → all considered absent.
- Constraints (`enum`, `pattern`, `minLength`, etc.) do not fire on absent values.
- A `required` field whose value is absent produces a `required` error at the **parent's** pointer with `params.missingProperty` naming the empty field.

This mirrors the rule `convertJsonToHtml` (via `prune` in `html/utils.js`) applies on save — absent values are stripped from the persisted document. The two definitions are written independently; a replacement serializer can adopt different rules without breaking validation.

### What does not get validated

- `metadata` — outside `data`.
- Subtrees with `kind: 'unsupported'`.
- Form-empty optional values.

---

## 9. Load-time type coercion

`html2json` is schema-agnostic — it produces a best-effort JSON tree from the saved HTML. Array primitives in particular come back as raw strings even when the schema declares `integer`, `number`, or `boolean`. To bridge the two worlds, `state-engine/index.js` runs `coerceData(parsed.data, definition)` immediately after parsing.

`coerceData` walks both trees in lockstep and casts primitive leaves to the schema's declared kind:

- `'1'` against `integer` / `number` → `1`
- `'true'` / `'false'` against `boolean` → `true` / `false`
- `42` against `string` → `"42"`
- Un-coercible values (e.g. `"abc"` against `integer`) pass through so the validator still flags them with a clear message
- `null` / `undefined`, unknown kinds, and shape mismatches pass through

Coercion runs once per `load` and on a small document — it is not in any hot path. With this step in place, the rest of the SDK can assume that `document.data` matches the schema's primitive kinds.

---

## 10. Defaults policy

Schema `default` values are **materialized into the document at load time** when the loaded `data` is empty. From that point on, defaults are real values in the document — they are saved on the first mutation, and renderers are a pure function of `node.value` with no special case for defaults.

### The three invariants

| Stage | Rule |
|---|---|
| **Load** | If `isDataEmpty(parsed.data)` → write schema defaults into `data` (recursively). A primitive with an explicit `default` materializes to that value. A boolean without an explicit default materializes to `false`. Other primitives without a default stay absent. Otherwise leave `data` alone. |
| **Render** | Consumer shows `node.value`. If `undefined`, show empty (or `false` for boolean). Renderers never read `node.defaultValue`. |
| **Save** | Prune empty strings / null / undefined / whitespace-only / empty branches from `data`, then serialize. `false` is **not** pruned. |

`isDataEmpty` and `prune` mirror each other on purpose: a value the loader treats as "empty enough to materialize over" is exactly a value the serializer would strip. If one definition changes, the other must too — covered by the symmetry tests in `test/state-engine/index.test.js`.

### Why booleans get an implicit default

A boolean field has exactly two visible states (checked, unchecked); there is no meaningful "absent." If a fresh document renders a checkbox as unchecked, the saved document must reflect that — otherwise the next load sees an empty doc, re-materializes, and the checkbox state is whatever the schema's default says, not what the user saw.

Materializing `false` for booleans without an explicit default makes the round-trip stable:

- `false` survives `prune()` on save.
- A saved document containing `{ flag: false }` is not `isDataEmpty`, so the next load does not re-materialize and the checkbox stays unchecked.
- This pattern only applies to booleans. For other primitives, materializing an empty placeholder would be stripped on save anyway. Booleans are the only primitive where the natural "empty" state is itself a persistable value.

### Where defaults can appear

| Source of a default reaching the consumer | When |
|---|---|
| Load-time materialization | Disk-empty document, schema carries defaults |
| `addItem` on an array | Consumer calls `engine.addItem(...)` — `mutate.js buildDefault` seeds the new item |
| *Anywhere else* | **Never.** The SDK does not synthesize defaults at render time. |

### Known limit

A document that has been edited and then fully cleared saves with empty `data`. On the next load `isDataEmpty` returns true and defaults re-materialize. This is a property of the storage format, not the engine — there is nowhere in the saved HTML to record "the user intentionally emptied this." If the storage format gains a representation for null-distinct-from-absent, materialization can be replaced with that distinction and the edge case disappears.

### Why `materializeDefaults` is distinct from `mutate.js`'s `buildDefault`

Both walk a definition tree and produce a default-filled value, but they have different jobs.

- `mutate.js buildDefault` seeds a complete shape for a new array item (a string without a default becomes `''`, ready for an input box).
- `state-engine/index.js materializeDefaults` writes only keys that carry real intent. Fields without a default stay absent so they prune to nothing on save.

They stay separate on purpose.

---

## 11. Rules

### NEVER

- Let `state-engine/` import from `html/` (or anything else).
- Let `state-engine/` depend on DOM or Lit.
- Silently degrade on unsupported schema features — produce a `kind: 'unsupported'` node and surface it on `state.schemaIssues`.
- Synthesize defaults outside `createEngine` initialization and `addItem`.

### ALWAYS

- Keep `state-engine/` and `html/` headless. The SDK has no DOM dependency anywhere.
- Use JSON Pointer for canonical addressing.
- Mirror `isDataEmpty` and `prune` — they are the same predicate from different sides.

---

## 12. Future work (deferred risks)

Items intentionally left until there's a concrete second consumer or migration to motivate them. Tracked here so they don't get lost.

### 12.1. Wire-format version stamp

The DA HTML wire format emitted by `convertJsonToHtml` has no version marker. The `<div class="da-form">` block carries `schemaName` and other metadata, but nothing identifying the producer's wire-format version. If the serialization changes in a breaking way (new block conventions, rename of `da-form`, different list markup), old and new documents on disk become indistinguishable to `convertHtmlToJson`.

**When this becomes urgent:** the first time we want to make a non-additive change to the HTML format and still read old documents.

**Likely fix:** add an explicit `x-format-version` row to the `da-form` block (e.g. `<div><div><h3>x-format-version</h3></div><div><p>1</p></div></div>`), emit it on every save, default to `1` when reading documents that lack it, and bump on any breaking change. Cheap to add now, expensive to retrofit later — but no urgency until we actually have two formats.

### 12.2. Pointer stability across reorders

JSON Pointers are positional (see §6) — when an array item moves, every pointer below it shifts. UI selection state, error highlighting, and any consumer-side cache keyed by pointer must be aware of this. The SDK does not provide stable identifiers; consumers that need them (e.g. drag-and-drop reordering with persistent selection) layer their own id-on-item scheme on top.

This is a documented constraint, not an open bug, but it's worth re-evaluating if a future consumer needs identity that survives reorders.

# SDK — Lifecycle

The order in which the SDK's internals run during each public call.

This doc traces what happens **when** you call a public function. Reference docs cover **what** each piece does — pair this with [schema-builder.md](./schema-builder.md), [model-builder.md](./model-builder.md), and [architecture.md](./architecture.md) for depth.

The SDK is fully synchronous. There is no async, no I/O, no DOM, no event loop involvement. Every call below returns by the time it finishes — `onChange` (when wired) is the only callback the SDK invokes.

---

## 1. `createEngine` lifecycle

```js
const engine = createEngine({ schema, document, onChange });
```

What runs, in order:

```txt
createEngine({ schema, document, onChange })
  ├─ compileSchema(schema)                    ← schema → definition tree
  │    └─ phase 1: resolveSchema
  │    │    ├─ deep-clone, inline $ref, flag composition / invalid patterns
  │    │    └─ collect schemaIssues for unsupported / unresolved nodes
  │    └─ phase 2: compileNode
  │         ├─ infer kind per node
  │         ├─ pick supported validation keywords (minLength, pattern, …)
  │         └─ build the definition tree (children / item / enumValues)
  │
  ├─ parseDocument(document)                  ← shape-check + deep-clone
  │    ├─ require object with metadata + data; reject otherwise
  │    └─ normalize: { metadata, data } — owned by the engine after this
  │
  ├─ if !definition || !parsed:
  │    └─ commit empty state, return early
  │
  ├─ coerceData(parsed.data, definition)      ← primitive leaves → schema kinds
  │    ├─ string→number for kind: 'number' / 'integer'
  │    ├─ 'true' / 'false' string → boolean for kind: 'boolean'
  │    └─ leaves unmatched values untouched (validator will flag them)
  │
  ├─ if isDataEmpty(parsed.data):
  │    └─ materializeDefaults(definition)     ← seed schema-declared defaults
  │         ├─ walks definition tree once
  │         └─ only fields that carry a real `default` (booleans get `false`)
  │
  └─ rebuildModel(parsed)
       ├─ buildModel(definition, parsed)      ← tree walk + byPointer index
       └─ validateDocument(parsed, model)     ← single pass, errors keyed by pointer
            └─ commitState(next)
                 ├─ state = next
                 └─ if (initialized) onChange?.()  ← suppressed during init
```

After `rebuildModel` returns, the engine sets `initialized = true`. From this point on, every mutation runs through the same `rebuildModel` → `commitState` → `onChange` path — but `onChange` now fires.

**Key invariants:**

- **Synchronous, top-to-bottom.** No `await`, no `Promise`, no microtasks.
- **`onChange` does NOT fire during init.** Consumers read the initial state via `engine.getState()` after the call returns.
- **No DOM, no fetch.** Everything is in-memory tree manipulation.
- **`document` is owned by the engine after this call.** Callers that need to keep their own reference should deep-clone before passing in.

Reference: [architecture.md §3 + §4](./architecture.md), [schema-builder.md](./schema-builder.md), [model-builder.md](./model-builder.md).

---

## 2. Mutation lifecycle

All seven mutation paths (`setField`, `addItem`, `insertItem`, `removeItem`, `moveItem`) flow through the same pipeline. Example using `setField`:

```txt
engine.setField(pointer, value)
  ├─ canMutate? guard                         ← needs definition + model
  ├─ nodeAt({ model, pointer })               ← O(1) byPointer lookup
  ├─ readonly? guard                          ← schema-declared read-only fields
  └─ commit(applySet({ document, pointer, value, node }))
       ├─ applySet (mutate.js)
       │    ├─ deepClone(document)            ← single clone per mutation
       │    ├─ shouldClear?                   ← empty value on a clearable field
       │    │    ├─ yes: clearValueAt(...)
       │    │    └─ no:  setValueAt(...)
       │    └─ return { document: next, changed }
       │
       ├─ if !changed: return state           ← reference identity preserved (no-op)
       │
       └─ rebuildModel(next)
            ├─ buildModel                     ← O(N) walk
            ├─ validateDocument               ← O(N) walk, error map updated
            └─ commitState(next)
                 ├─ state = next
                 └─ onChange?.()              ← consumer-visible notification
```

**Variants:**

- **`addItem(pointer)`** — `applyAdd` runs `ensureArray` + `buildDefault(itemDefinition)` to seed defaults for the new item, then `insertValueAt(end)`. Same `commit` pipeline after.
- **`insertItem(pointer)`** — `applyInsert` inserts the seeded default at `pointer`'s position (shifting siblings down).
- **`removeItem(pointer)`** — `applyRemove` splices out `pointer`'s item. Skipped only when the array is `required` and removal would drop it below `minItems`; an optional array can always be cleared back to empty.
- **`moveItem(pointer, fromIndex, toIndex)`** — `applyMove` splices 1 out at `fromIndex` and splices in at `toIndex`. No-op when `fromIndex === toIndex`.

**Mutation-level invariants:**

- **One `deepClone` per mutation.** The clone is the price of immutable-ish state semantics; no in-place edits.
- **Mutation no-ops preserve state identity.** Setting a field to its current value returns the same `state` reference — Lit / other reference-comparison consumers can skip work.
- **One `onChange` per mutation.** Even if the mutation triggers internal cascades (model rebuild, validation pass), the consumer sees exactly one notification.
- **Reference comparison detects mutations.** Every real mutation produces a new `document` reference; non-mutation calls keep the same one. Consumers (e.g. the form block's persistence layer) use this to skip non-mutation `onChange` events.

Reference: [architecture.md §4 + §8 + §10](./architecture.md), [model-builder.md](./model-builder.md).

---

## 3. Stateless lifecycles

The other public functions share infrastructure but hold no state between calls.

### 3.1. `validateData({ schema, data })`

```txt
validateData({ schema, data })
  ├─ compileSchema(schema)                    ← same as createEngine §1
  ├─ if no definition: return early
  │    └─ { valid: false, errors: {}, schemaIssues }
  ├─ document = { metadata: {}, data: data ?? {} }
  ├─ buildModel(definition, document)         ← throwaway model
  ├─ validateDocument(document, model)
  └─ return { valid, errors, schemaIssues }
       valid = schemaIssues empty AND errors empty
```

One-shot. The compiled definition and the built model are dropped when the function returns — no caching across calls. For repeated validation against the same schema, use `createEngine` (which compiles once and reuses the definition across mutations).

### 3.2. `validateSchema({ schema })`

```txt
validateSchema({ schema })
  ├─ compileSchema(schema)
  └─ return { valid: !!definition && schemaIssues.empty, schemaIssues }
```

Schema-only. Skips data parsing, model building, and document validation — useful for "is this schema well-formed?" without any data on hand.

### 3.3. `convertJsonToHtml({ json })`

```txt
convertJsonToHtml({ json })
  ├─ shape-check: json is an object with metadata.schemaName (string)
  │    └─ if not: return { error: '<reason>' }
  ├─ pruned = prune(json.data)                ← drop empty/null/whitespace leaves
  └─ html = json2html({ ...json, data: pruned })
       ├─ build <body><main><div>…</div></main></body> via template literals
       └─ recursively emit <div class="<schemaName>"> nodes for nested objects/arrays
  return { html }
```

Pure string builder. No DOM, no async. Symmetric with `convertHtmlToJson`.

### 3.4. `convertHtmlToJson({ html })`

```txt
convertHtmlToJson({ html })
  ├─ shape-check: html is a non-empty string
  │    └─ if not: return { error: '...' }
  ├─ parse via hast-util-from-html (parse5 internally)
  ├─ walk the hast tree:
  │    ├─ find <div class="da-form"> block → metadata (schemaName, …)
  │    ├─ find <div class="<schemaName>"> block → data
  │    └─ resolve `self://#…` references between blocks
  └─ return { json: { metadata, data } }
```

Tag-agnostic for keys and primitive values (anything text-content readable works: `<p>`, `<h1>`-`<h6>`, `<span>`, bare text). The only tag check is for `<ul>` / `<ol>` to distinguish arrays from scalars. Pre-existing tolerance for pretty-printed HTML (whitespace text nodes between tags) and direct-text value cells.

---

## 4. Cost characteristics

Approximate cost per call. **N** = number of fields in the document; **D** = byte size of the document; **schema** = number of nodes in the compiled definition tree.

| Operation | Cost | Notes |
|---|---|---|
| `createEngine` | O(schema + D + N) | One-time per engine. Includes compile + parse + coerce + model build + initial validate. |
| `setField` / `addItem` / `insertItem` / `removeItem` / `moveItem` | O(D + N) | Deep-clone the document, rebuild the model, validate the whole document. |
| Mutation no-op (same value) | O(1) | `applySet` exits with `changed: false`; no clone, no rebuild. |
| `getState()` | O(1) | Returns the current state reference. |
| `validateSchema` | O(schema) | Compile only; no model, no data. |
| `validateData` | O(schema + D + N) | Compile + buildModel (throwaway) + validate. No caching across calls. |
| `convertJsonToHtml` | O(D) | Prune (O(D)) + string build (O(D)). |
| `convertHtmlToJson` | O(html length) | parse5 + tree walk. |

For typical forms (50–500 fields, < 200 KB JSON):
- `createEngine` runs in a few ms.
- Mutations are sub-frame (< 16 ms) — the SDK is not the bottleneck on a keystroke pipeline.
- Validation cost dominates above ~500 fields; see [architecture.md §8](./architecture.md) for the design rationale (cross-field rules force full re-validation).

---

## 5. The synchronicity boundary

The SDK is intentionally synchronous end-to-end. Concretely:

- **No `Promise`, no `async`/`await`** anywhere in the source.
- **No `setTimeout`, no `setInterval`, no microtask scheduling.**
- **No `fetch`, no `XMLHttpRequest`, no network anything.**
- **No `document`, no `DOMParser` at the SDK boundary.** `convertHtmlToJson` uses `hast-util-from-html` (pure parse5) internally; everything else is plain ESM.
- **No `onChange` during construction.** Consumers read initial state explicitly.

Async lives at the consumer's boundary, not the SDK's. The typical pattern:

```js
const engine = createEngine({
  schema,
  document,
  onChange: () => {
    // Consumer's async happens here:
    //   - schedule a save (single-flight, see headless-consumer.md)
    //   - dispatch to a UI framework's render queue
    //   - emit a custom event
  },
});
```

This makes the SDK:
- **Trivially testable** — no fake timers, no mocked network.
- **Portable to edge runtimes** — Cloudflare Workers, Deno, Bun all have ESM and ES2022 but limited async APIs; the SDK doesn't need them.
- **Predictable in semantic ordering** — `setField` returns the new state; you can chain mutations and read the result without `await`.

---

## 6. Where each phase is defined

For depth on any single phase, follow the link:

| Phase | Lives in | Deep-dive doc |
|---|---|---|
| `compileSchema` | `src/state-engine/schema.js` | [schema-builder.md](./schema-builder.md) |
| `parseDocument` / `coerceData` / `isDataEmpty` / `materializeDefaults` | `src/state-engine/index.js` | [architecture.md §9 + §10](./architecture.md) |
| `buildModel` | `src/state-engine/model.js` | [model-builder.md](./model-builder.md) |
| `validateDocument` | `src/state-engine/validation.js` | [architecture.md §8](./architecture.md) |
| `applySet` / `applyAdd` / `applyInsert` / `applyRemove` / `applyMove` | `src/state-engine/mutate.js` | [architecture.md §4](./architecture.md) |
| `prune` / `json2html` / `HTMLConverter` | `src/html/` | [architecture.md §1 + §2](./architecture.md) |

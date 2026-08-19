# Validation behavior

How the SDK validates a document against a schema, and what the author sees.

Companion to [`schema-spec.md`](./schema-spec.md): that document defines which
schema keywords are *supported*; this one defines what *validation does* with
them, keyword by keyword, with a worked example of every combination.

- **Scope:** the keyword subset in `schema-spec.md` §2–5. Anything outside it is
  ignored (see [§8](#8-what-validation-does-not-check)).
- **Entry point:** `validateData({ schema, data })` → `{ valid, errors, schemaIssues }`.
  The stateful engine runs the same validation on every mutation.

> **Example convention.** Schema snippets below omit `title` (which the spec
> requires on every node) for brevity, and each example is scoped to the fields
> under discussion. Every result shown is produced by the actual validator.

---

## 1. The error model

`errors` is a **pointer-keyed map**, one entry per failing location:

```json
{
  "/data/authors/0/name": {
    "keyword": "required",
    "instancePath": "/data/authors/0/name",
    "params": { "missingProperty": "name" },
    "message": "This field is required."
  }
}
```

- `keyword` — the JSON Schema keyword that failed.
- `instancePath` — RFC 6901 pointer into the data, rooted at `/data`.
- `params` — keyword-specific detail (`limit`, `pattern`, `allowedValues`, `missingProperty`, `type`).
- `message` — a complete, capitalized, period-terminated sentence, meant to be shown directly.

**One error per pointer** — the first failing check on a node wins. UI consumers
do `errors[pointer]?.message`; agents iterate `Object.values(errors)`.

---

## 2. Core principles

Five rules explain every behavior below.

### 2.1 Validation checks the *working* document, not the saved one

Validation runs against exactly what the author is editing — including rows they
have added but not yet filled. It is **authoring-time feedback**, not a check of
the persisted artifact. (Saving prunes empties; see §2.2.)

### 2.2 "Form-empty" means absent — recursively

A value is **empty** when it would prune to nothing on save:

| Value | Empty? |
| ----- | ------ |
| `""`, `"   "` (whitespace) | yes |
| `null`, `undefined` | yes |
| `[]`, or an array whose every item is empty | yes |
| `{}`, or an object whose every leaf is empty (e.g. `{ "name": "" }`) | yes |
| `0`, `false` | **no** — a real value |
| `{ "name": "Ada" }`, `["a"]` | **no** |

Emptiness is **recursive**: `{ "meta": { "title": "" } }` is empty, because the
only leaf beneath it is blank and the whole thing strips away on save. The same
predicate drives presence checks, item counting, and pruning, so *what
validation accepts is exactly what survives save.*

### 2.3 Constraints do not fire on an empty optional value

An empty optional field is absent, so `enum` / `pattern` / `minLength` / etc. are
**not** enforced. Constraints apply only once the value has content.

### 2.4 `required` means "must have a non-empty value"

`required` (declared on the parent object) is satisfied by a **non-empty** value,
not merely a present key. An empty required value is flagged — with wording that
matches the control:

| Required node | Message |
| ------------- | ------- |
| scalar | `This field is required.` |
| object | `This section is required.` |
| array | `Must contain at least one item with content.` (or the `minItems` count) |

### 2.5 Arrays: present once they have rows; counted by content

- An array is **present** the moment it has any rows — even blank ones.
- A present array is validated (its `minItems`/`maxItems` surface immediately),
  and **every existing row is validated** — so a row's required fields fire as
  soon as the row exists. The author fills the row or removes it.
- `minItems`/`maxItems` count only **rows with content** — blank rows do not
  count (they prune away), so they never let a minimum be met by empty rows.
- An array with **no rows at all** is absent (its required-ness, if any, is
  handled by the parent).

> **The save guarantee.** Because the same emptiness predicate governs
> validation and pruning, a document the SDK reports **valid** always prunes to a
> document that still satisfies the supported schema keywords — including under
> AJV, within the supported subset. Validating the working document *subsumes*
> validating the saved one: once every empty row is filled or removed, the two
> agree.

---

## 3. Scalars

`string`, `number`, `integer`, `boolean`. Constraints fire only when the value is
present (§2.3).

| Keyword | Applies to | Message |
| ------- | ---------- | ------- |
| type | all | `Must be a string.` / `Must be a number.` / `Must be an integer.` / `Must be a boolean.` |
| `minLength` | string | `Must be at least N characters.` |
| `maxLength` | string | `Must be at most N characters.` |
| `pattern` | string | `Must match the pattern "…".` |
| `enum` | string | `Must be one of the allowed options.` |
| `format` (date) | string | `Must be a valid date.` |
| `format` (time) | string | `Must be a valid time.` |
| `format` (date-time) | string | `Must be a valid date and time.` |
| `minimum` | number, integer | `Must be greater than or equal to N.` |
| `maximum` | number, integer | `Must be less than or equal to N.` |

**Schema**

```json
{
  "type": "object",
  "properties": {
    "name":   { "type": "string",  "minLength": 3 },
    "code":   { "type": "string",  "pattern": "^[a-z]+$" },
    "status": { "type": "string",  "enum": ["A", "B"] },
    "count":  { "type": "integer", "minimum": 5 },
    "active": { "type": "boolean" }
  }
}
```

**Documents and results**

```text
{ "name": "ab" }      → /data/name     Must be at least 3 characters.
{ "name": "" }        → valid          (empty optional — constraint suppressed)
{ "code": "AB1" }     → /data/code     Must match the pattern "^[a-z]+$".
{ "status": "X" }     → /data/status   Must be one of the allowed options.
{ "count": 1 }        → /data/count    Must be greater than or equal to 5.
{ "count": 1.5 }      → /data/count    Must be an integer.
{ "name": 42 }        → /data/name     Must be a string.
{ "active": "yes" }   → /data/active   Must be a boolean.
```

`0` and `false` are real values, not empty — a `required` number field is
satisfied by `0`, a `required` boolean by `false`.

### Date and time (`format`)

`format` (`date` / `time` / `date-time`) validates the value's shape *and* its
real calendar/clock validity. `date-time` is constrained to canonical UTC — a
trailing `Z`, zero seconds — so every writer produces one identical value.

**Schema**

```json
{
  "type": "object",
  "properties": {
    "day":   { "type": "string", "format": "date" },
    "at":    { "type": "string", "format": "time" },
    "start": { "type": "string", "format": "date-time" }
  }
}
```

**Documents and results**

```text
{ "day": "2026-08-14" }                  → valid
{ "day": "2026-02-30" }                  → /data/day    Must be a valid date.
{ "day": "08/14/2026" }                  → /data/day    Must be a valid date.
{ "at": "09:30" }                        → valid
{ "at": "24:00" }                        → /data/at     Must be a valid time.
{ "start": "2026-08-14T13:00:00Z" }      → valid
{ "start": "2026-08-14T13:00:00.000Z" }  → valid        (millisecond zeros allowed)
{ "start": "2026-08-14T13:00:00+02:00" } → /data/start  Must be a valid date and time.  (offset — not UTC)
{ "start": "2026-08-14T13:00:30Z" }      → /data/start  Must be a valid date and time.  (non-zero seconds)
{ "start": "" }                          → valid        (empty optional — constraint suppressed)
```

The error carries `keyword: "format"` and `params: { format }`.

---

## 4. Objects (sections)

An object is validated by validating its children, plus a `required` check for
each named child.

**Schema**

```json
{
  "type": "object",
  "required": ["seo"],
  "properties": {
    "seo": {
      "type": "object",
      "required": ["metaTitle"],
      "properties": {
        "metaTitle":       { "type": "string" },
        "metaDescription": { "type": "string" }
      }
    }
  }
}
```

**Documents and results**

```text
{ "seo": { "metaTitle": "" } }
  → /data/seo             This section is required.
  → /data/seo/metaTitle   This field is required.
  (the section is empty — every leaf is blank — so both the section and its
   required field are flagged; prunes to nothing)

{ "seo": { "metaTitle": "", "metaDescription": "A description." } }
  → /data/seo/metaTitle   This field is required.
  (the section has content, so it is not "required"; we validate inside it —
   the required metaTitle is missing; prunes to { "seo": { "metaDescription": "A description." } })
```

A child's `required` error lands on the **child's** pointer, with
`params.missingProperty` set.

---

## 5. Arrays

### 5.1 Array of scalars

**Schema** (optional array)

```json
{
  "type": "object",
  "properties": {
    "tags": { "type": "array", "minItems": 2, "items": { "type": "string" } }
  }
}
```

**Documents and results**

```text
{}                     → valid          (no rows → absent)
{ "tags": ["", ""] }   → /data/tags     Must contain at least 2 items with content.
                         (rows exist → present; blank rows don't count; prunes to nothing)
{ "tags": ["a", ""] }  → /data/tags     Must contain at least 2 items with content.
                         (1 item with content < 2; prunes to { "tags": ["a"] })
{ "tags": ["a", "b"] } → valid
```

Other variants of the same array:

```text
maxItems: 2, { "tags": ["a", "b", "c"] }   → /data/tags   Must contain at most 2 items.
required + minItems: 3, { "tags": [] }      → /data/tags   Must contain at least 3 items with content.
```

### 5.2 Array of objects

Every existing row is validated, and the count surfaces at once.

**Schema** (optional array, `minItems: 2`)

```json
{
  "type": "object",
  "properties": {
    "authors": {
      "type": "array",
      "minItems": 2,
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name":  { "type": "string" },
          "email": { "type": "string" }
        }
      }
    }
  }
}
```

**Documents and results**

```text
{ "authors": [ { "name": "", "email": "" } ] }
  → /data/authors          Must contain at least 2 items with content.
  → /data/authors/0/name   This field is required.
  (prunes to nothing — the blank row would not persist)

{ "authors": [ { "name": "", "email": "a@b" } ] }
  → /data/authors          Must contain at least 2 items with content.
  → /data/authors/0/name   This field is required.
  (the row has content, so it survives save — its missing required name is real;
   prunes to { "authors": [ { "email": "a@b" } ] })

{ "authors": [ { "name": "Ada" }, { "name": "Grace" } ] }
  → valid
```

---

## 6. Nesting (arrays in arrays of objects)

The same rules apply at every depth. This schema nests
array → object → array → object → array of strings:

**Schema**

```json
{
  "type": "object",
  "properties": {
    "chapters": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["heading", "sections"],
        "properties": {
          "heading": { "type": "string", "minLength": 2 },
          "sections": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "required": ["label"],
              "properties": {
                "label":    { "type": "string" },
                "keywords": { "type": "array", "minItems": 2, "items": { "type": "string" } }
              }
            }
          }
        }
      }
    }
  }
}
```

**Documents and results**

```text
{ "chapters": [ { "heading": "", "sections": [ { "label": "", "keywords": [""] } ] } ] }
  → /data/chapters                       Must contain at least one item with content.
  → /data/chapters/0/heading             This field is required.
  → /data/chapters/0/sections            Must contain at least one item with content.
  → /data/chapters/0/sections/0/label    This field is required.
  → /data/chapters/0/sections/0/keywords Must contain at least 2 items with content.
  (prunes to nothing)

{ "chapters": [ { "heading": "Intro",
    "sections": [ { "label": "Overview", "keywords": ["a", "b"] } ] } ] }
  → valid
```

Note that `chapters` (with one real chapter) shows **no** count error even while
a descendant is invalid — `minItems` measures *how many items*, not *whether each
item is fully valid*. The deep problem is reported at its own pointer. (This
matches AJV: with one item present it reports the nested error, not a `chapters`
`minItems` error.)

---

## 7. Empty-value & prune reference

| Document | Schema | Verdict | Saved (pruned) |
| -------- | ------ | ------- | -------------- |
| `{ "status": "" }` | optional enum | valid (absent) | `{}` — key dropped |
| `{ "name": "" }` | required string | `This field is required.` | — (blocked) |
| `{ "tags": [] }` | optional `minItems:2` | valid (absent) | key dropped |
| `{ "tags": ["", ""] }` | optional `minItems:2` | `…at least 2 items with content.` | key dropped |
| `{ "seo": { "metaTitle": "" } }` | required object | `This section is required.` (+ child) | — (blocked) |
| `{ "authors": [ { "name": "" } ] }` | object rows | row `name` required + count | key dropped |

Empty leaves are stripped on save; a container that empties out is dropped
entirely. What validation calls "absent" is exactly what pruning removes.

---

## 8. What validation does *not* check

Only the keywords in `schema-spec.md` §2–5 are validated. Any other constraint
keyword is **silently ignored** — the SDK does not enforce it, and data that
violates it will still be reported valid:

`multipleOf`, `const`, `uniqueItems`, `exclusiveMinimum`, `exclusiveMaximum`,
`enum` on non-string types, `format` values other than `date` / `time` /
`date-time` (e.g. `email`, `uri`, `uuid`), and anything else outside §2–5.

(`format: date | time | date-time` **is** validated — see §3.)

The save guarantee (§2.5) therefore holds **within the supported subset**: if a
schema restricts itself to supported keywords, SDK-valid data conforms to the
schema (and to AJV). If a schema uses an unsupported constraint keyword, the SDK
neither enforces nor reports it — so validity against the SDK does not imply
validity against a full JSON Schema validator for that keyword.

---

## 9. Message reference

| Keyword | Message |
| ------- | ------- |
| `required` (scalar) | `This field is required.` |
| `required` (object) | `This section is required.` |
| `required` / `minItems` (array) | `Must contain at least N items with content.` · singular `…at least one item with content.` |
| `maxItems` | `Must contain at most N items.` |
| `minLength` | `Must be at least N characters.` |
| `maxLength` | `Must be at most N characters.` |
| `pattern` | `Must match the pattern "…".` |
| `enum` | `Must be one of the allowed options.` |
| `format` (date) | `Must be a valid date.` |
| `format` (time) | `Must be a valid time.` |
| `format` (date-time) | `Must be a valid date and time.` |
| `minimum` | `Must be greater than or equal to N.` |
| `maximum` | `Must be less than or equal to N.` |
| type (string) | `Must be a string.` |
| type (number) | `Must be a number.` |
| type (integer) | `Must be an integer.` |
| type (boolean) | `Must be a boolean.` |
| type (array) | `Must be an array.` |

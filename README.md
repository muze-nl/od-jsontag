# od-jsontag: On Demand JSONTag

`od-jsontag` is a lazy parser and serializer for large JSONTag-style object graphs.
It stores data as one object per line, keeps references between objects as line
numbers, and creates JavaScript `Proxy` objects so values are parsed only when
your code actually touches them.

The goal is to let you work with large, connected data structures through a
normal object API without paying the full parse cost up front.

```js
import Parser from '@muze-nl/od-jsontag'
import serialize, {stringify} from '@muze-nl/od-jsontag/src/serialize.mjs'

const data = {
  articles: [
    {title: 'On demand parsing'}
  ]
}

const buffer = serialize(data)
const parser = new Parser()
const root = parser.parse(buffer)

// The root proxy exists immediately. Referenced objects are parsed on access.
console.log(root.articles[0].title)

console.log(stringify(buffer))
```

## Why od-jsontag exists

`od-jsontag` was made for data that is too connected and too large to comfortably
parse as one regular JSON document, but still wants to be used like ordinary
JavaScript objects.

JSON is excellent when you want to load a complete tree. It is less ideal when:

- the file is large;
- most requests only touch a small part of the data;
- many objects reference the same object;
- the data needs to be shared between workers;
- identity matters, so repeated references should point at the same object;
- you want to preserve JSONTag metadata such as types and attributes.

`od-jsontag` approaches this by splitting a graph into lines. Line `0` is the
root. Other lines are objects that can be referenced by `~1`, `~2`, and so on.
The parser can scan the file and create lightweight proxies for each line, or it
can use a supplied line index and skip the scan entirely. With an index, only the
root line is parsed at first; referenced lines become proxies and parse lazily
when accessed.

This is especially useful with `SharedArrayBuffer`, because the same serialized
data can be shared with workers without copying the full object graph into each
worker.

## When to use it

Use `od-jsontag` when you have large, mostly-read object graphs and only a
fraction of the objects are needed for a given operation.

Good fits:

- large JSONTag datasets where references and identity matter;
- read-heavy applications that open a large data file and inspect small parts;
- worker-based Node.js applications sharing data through `SharedArrayBuffer`;
- graph-like data where the same entity appears from many paths;
- data with JSONTag object attributes, typed values, or non-enumerable
  properties;
- applications that need access control hooks around object properties.

## When not to use it

Do not use `od-jsontag` just because a file is JSON-shaped. For small files,
`JSON.parse` or `JSONTag.parse` will usually be simpler and faster.

It is probably not the right fit when:

- you always need the full dataset immediately;
- your data is a plain tree with no shared references or identity concerns;
- you need broad query/filter/aggregate operations over millions of rows;
- you need a stable cross-language binary format;
- you need transactional updates, indexing, and persistence like a database;
- you want browser compatibility. The current project targets Node.js.

For analytical workloads that scan a few fields across many similar objects, a
columnar format or database may be a better match. `od-jsontag` is intentionally
object-oriented: it optimizes lazy object access, not column scans.

## Core ideas

### One object per line

Serialized output is a newline-separated sequence of length-prefixed JSONTag
values:

```text
(23){"foo":[~1],"bar":[~2]}
(57)<object class="foo" id="1">{"name":"Foo",#"hidden":"bar"}
(57)<object class="bar" id="2">{"name":"Bar","children":[~1]}
```

Each line starts with `(N)`, where `N` is the byte length of the JSONTag value
after the prefix. References use `~lineNumber`.

See [docs/data-format.md](docs/data-format.md) for a simple explanation of the
format.

### Lazy proxies

`parse()` returns a proxy for the root value. Referenced objects are represented
by proxies as well. The object body is parsed only when code reads a property,
enumerates keys, checks `in`, defines a property, deletes a property, or performs
another operation that needs the object contents.

```js
const root = parser.parse(buffer)

// Parses root, then the referenced object at line 1.
console.log(root.foo[0].name)
```

### Optional line index

If you already have an index of line number to byte positions, pass it as the
second argument to `parse()`:

```js
const index = [
  [0, 28],
  [29, 98],
  [99, 161]
]

const root = parser.parse(buffer, JSON.stringify(index))
```

The index is a JSON array where each entry is `[start, end]` byte offsets in the
data file. It can be supplied as:

- an already parsed array;
- a JSON string;
- a `Uint8Array` containing JSON;
- a path to a JSON file;
- a file descriptor or object with `.fd` for a JSON index file.

When parsing with an index, `input` can also be a file descriptor. In that mode,
`od-jsontag` reads only the byte range needed for each line.

```js
import {openSync, closeSync} from 'node:fs'

const dataFd = openSync('data.odjt', 'r')

try {
  const root = parser.parse(dataFd, 'data.odjt.index.json')
  console.log(root.foo[0].name)
} finally {
  closeSync(dataFd)
}
```

## Mutability

Parsers are immutable by default:

```js
const parser = new Parser()
const root = parser.parse(buffer)

root.name = 'New name' // throws
```

Create a mutable parser by passing `false` as the second constructor argument or
by setting `parser.immutable = false`:

```js
const parser = new Parser(undefined, false)
const root = parser.parse(buffer)

root.name = 'New name'
```

Changed objects are serialized again. Unchanged parsed proxies can copy their
original byte range back into the output.

## Access control

You can install an access hook on `parser.meta.access`:

```js
const parser = new Parser()

parser.meta.access = (object, property, method) => {
  return property === 'name'
}

const root = parser.parse(buffer)

console.log(root.name)  // allowed
console.log(root.secret) // undefined
```

The `method` argument is usually one of:

- `get`
- `set`
- `has`
- `deleteProperty`
- `defineProperty`

Access denial returns `undefined` or `false`, depending on the proxy operation.

## Serialization

Use `serialize(value, options)` to create the od-jsontag byte representation.
It returns a `Uint8Array` backed by a `SharedArrayBuffer`.

```js
const buffer = serialize(root)
const text = stringify(buffer)
```

Useful options:

- `meta`: share parser metadata such as `resultArray` and the id index.
- `changes: true`: serialize only changed lines as a patch-style stream.
- `skipLength: true`: internal option used when serializing a single line body.

See [docs/reference.md](docs/reference.md) for the API reference.

## JSONTag compatibility

`od-jsontag` builds on [`@muze-nl/jsontag`](https://github.com/muze-nl/jsontag/).
It preserves JSONTag types and attributes for serialized values. It also adds
support for non-enumerable object properties by prefixing the property with `#`
inside the line format:

```text
(57)<object class="foo" id="1">{"name":"Foo",#"hidden":"bar"}
```

## Documentation

- [API reference](docs/reference.md)
- [Data format](docs/data-format.md)

## Development

Run the direct test files with Node:

```sh
node --input-type=module -e "await import('./test/parse.mjs'); await import('./test/serialize.mjs');"
```

Coverage can be generated with:

```sh
node node_modules/c8/bin/c8.js --reporter=text --reporter=text-summary node --input-type=module -e "await import('./test/parse.mjs'); await import('./test/serialize.mjs');"
```

At the moment the package `npm test` command uses the tap CLI, which may report
the ESM test files as "no tests found" in some environments.

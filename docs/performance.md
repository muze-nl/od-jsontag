# Performance Tradeoffs

`od-jsontag` is designed for a specific performance shape: large object graphs
where a program usually touches only a small part of the data.

It is not a faster replacement for `JSON.parse()` in every situation. Standard
JSON is highly optimized in Node.js and is hard to beat when you need the whole
document. `od-jsontag` becomes interesting when lazy access avoids parsing most
object bodies, or when file-backed access avoids loading the whole data file.

## Summary

Use standard JSON when:

- the data is small;
- you always need the full object tree;
- you do not need object identity or shared references;
- you want the simplest possible format and tooling.

Use od-jsontag when:

- the data is large;
- most operations touch only part of the graph;
- object identity and references matter;
- the same serialized data is shared with workers;
- you can keep or generate a line index;
- you want file-backed lazy access.

The short version from the benchmark below:

- `JSON.parse()` is very fast for full parse.
- od-jsontag with no index must scan the whole file and create one proxy per
  line, so it is not automatically cheaper.
- od-jsontag with an index can parse the root much faster. In immutable mode,
  arrays that are just line ranges are kept lazy too.
- Accessing a small subset can use much less heap than full JSON parsing.
- File-backed indexed parsing can avoid keeping the data file in memory, at the
  cost of file reads for newly touched lines.

## Benchmark Setup

The benchmark used Node.js `v24.7.0` and a generated dataset with:

- `100,000` objects;
- one root object containing `items: [~1-100000]`;
- each item has six scalar properties:
  `id`, `name`, `group`, `active`, `score`, and `description`;
- partial-access scenarios read `1,000` scattered objects.

Compared formats:

- Standard JSON, parsed with `JSON.parse()`.
- Node's built-in V8 serializer, decoded with `v8.deserialize()`.
- od-jsontag backed by a `SharedArrayBuffer`, no line index.
- od-jsontag backed by a `SharedArrayBuffer`, with a parsed line index.
- od-jsontag backed by a file descriptor, with a parsed line index.

Rows below are representative isolated Node process runs with `--expose-gc`.
Memory is measured with `process.memoryUsage()` after explicit GC.

The measurements are not universal. They are a snapshot on one machine and one
data shape. They are still useful because they show the relative shape of the
tradeoff.

## Reproducing the Benchmark

The benchmark code lives in [benchmark/performance.mjs](../benchmark/performance.mjs).

For a quick same-process summary:

```sh
node benchmark/performance.mjs --runs=5 --objects=100000 --accessed=1000
```

This is convenient for timing, but memory deltas are cleaner when each scenario
runs in its own process.

For the cleanest memory measurements, run individual scenarios in fresh Node
processes with `--expose-gc`:

```sh
node --expose-gc benchmark/performance.mjs --scenario=json_parse_full --objects=100000 --accessed=1000
node --expose-gc benchmark/performance.mjs --scenario=v8_deserialize_full --objects=100000 --accessed=1000
node --expose-gc benchmark/performance.mjs --scenario=od_sab_scan_root --objects=100000 --accessed=1000
node --expose-gc benchmark/performance.mjs --scenario=od_sab_index_root --objects=100000 --accessed=1000
node --expose-gc benchmark/performance.mjs --scenario=od_sab_index_access --objects=100000 --accessed=1000
node --expose-gc benchmark/performance.mjs --scenario=od_file_index_access --objects=100000 --accessed=1000
```

Single-scenario mode prints one JSON row. Use multiple runs on your own machine
when you need stable numbers for a specific deployment.

## Input Size

| Format | Data size | Index size | Notes |
| --- | ---: | ---: | --- |
| JSON text | 10.18 MiB | none | One complete JSON tree |
| V8 serialized buffer | 9.44 MiB | none | Node/V8-specific binary representation |
| od-jsontag data | 10.66 MiB | none | Line-based text format |
| od-jsontag data + index | 10.66 MiB | 1.72 MiB | Index is a JSON array of byte ranges |

The od-jsontag data is slightly larger than JSON in this dataset because each
line has a length prefix and object references are stored separately. The index
is extra data. If you keep the index as a parsed JavaScript array, it also has a
runtime heap cost.

## Time Results

| Scenario | Work done | Time |
| --- | --- | ---: |
| `JSON.parse()` | Parse full dataset, then read 1,000 objects | 30.03 ms |
| `v8.deserialize()` | Decode full dataset, then read 1,000 objects | 66.73 ms |
| od-jsontag SAB, no index | Scan all lines, create proxies, parse root | 39.58 ms |
| od-jsontag SAB, indexed | Parse root only | 1.40 ms |
| od-jsontag SAB, indexed | Parse root and read 1,000 objects | 14.96 ms |
| od-jsontag file, indexed | Parse root and read 1,000 objects | 16.39 ms |

What this means:

- Full JSON parsing is fast, but it always creates the full object tree.
- od-jsontag without an index still pays an up-front scan and proxy creation
  cost for every line.
- od-jsontag with an index has a much smaller start-up cost because it reads and
  parses only line `0`.
- Accessing 1,000 objects remains cheaper than parsing all 100,000 object bodies
  in this dataset.
- File-backed access is close to SAB-backed access when the OS file cache is
  warm, but each newly touched line still requires a file read.

## Memory Results

The table below reports total retained memory after the operation. It includes
the input representation kept alive by the benchmark.

| Scenario | RSS delta | Heap delta | ArrayBuffer delta | External delta |
| --- | ---: | ---: | ---: | ---: |
| `JSON.parse()` full dataset | 78.52 MiB | 26.13 MiB | 0 MiB | 0 MiB |
| `v8.deserialize()` full dataset | 74.91 MiB | 18.24 MiB | 0 MiB | 9.44 MiB |
| od-jsontag SAB, no index | 79.44 MiB | 18.19 MiB | 10.66 MiB | 0 MiB |
| od-jsontag SAB, indexed root only | 72.73 MiB | 7.80 MiB | 10.66 MiB | 0 MiB |
| od-jsontag SAB, indexed + 1,000 objects | 73.75 MiB | 8.54 MiB | 10.76 MiB | 0.11 MiB |
| od-jsontag file, indexed + 1,000 objects | 62.96 MiB | 8.55 MiB | 0.11 MiB | 0.11 MiB |

The most important comparison is heap usage:

- JSON needs about `26.13 MiB` of heap after parsing the dataset.
- od-jsontag SAB with an index and 1,000 accessed objects needs about
  `8.54 MiB` of heap, plus the shared byte buffer.
- od-jsontag file-backed access has similar heap use but does not retain the
  data file as an in-memory `ArrayBuffer`.

This is the memory tradeoff od-jsontag is meant to expose: keep the serialized
data compact and lazy, then pay JavaScript object memory only for the part of the
graph you actually use.

## Why Indexed od-jsontag Still Uses Heap

Indexed parsing does not mean "zero allocation".

In the benchmark, the root line contains:

```text
{"items":[~1-100000]}
```

In immutable indexed parsing, od-jsontag keeps this as one lazy range array. It
does not create 100,000 line-reference objects at root parse time. The array
knows its start and end line numbers, and each numeric entry creates or reuses
the matching line proxy only when accessed.

The indexed root-only case still retains about `7.80 MiB` of heap because it
must keep:

- the parsed index array;
- the root object;
- the root `items` array shell and lazy range metadata.

If you enumerate the whole array with `Object.keys()`, `map()`, or a full
iteration, the proxies for those entries are created as needed. Mutable parsing
currently falls back to the older materialized line-reference array so mutation
tracking can keep its existing behavior.

## File-backed vs SharedArrayBuffer-backed

With `SharedArrayBuffer`:

- the data bytes stay in memory;
- referenced lines are sliced from memory;
- access is fast and worker-friendly;
- memory includes the data buffer.

With a file descriptor and line index:

- the data file can stay on disk;
- only accessed line ranges are read;
- memory can be lower for very large files;
- random access depends on file I/O and OS cache behavior.

In the benchmark, file-backed access used less total RSS because it did not keep
the 10.66 MiB data buffer in memory. Timing was close because the file was small
and warm in the OS cache. On cold storage or slow disks, file-backed access can
be slower.

## JSON Index Cost

The benchmark above uses an already parsed line index array to focus on data
access cost.

If you pass a JSON index file path to `parse()`, od-jsontag must read and
`JSON.parse()` that index. For a large index this can dominate startup time.

For repeated parses, consider keeping the parsed index in memory and passing the
array directly:

```js
const index = JSON.parse(await readFile('data.odjt.index.json', 'utf8'))
const root = parser.parse(buffer, index)
```

For one-off reads, passing the path is simpler:

```js
const root = parser.parse(fd, 'data.odjt.index.json')
```

## Comparison With Other Formats

### Standard JSON

Standard JSON is the baseline. It is built into Node, very fast, widely
understood, and easy to debug.

Its limitation is that `JSON.parse()` creates the whole object tree. If you only
need 1,000 objects out of 100,000, JSON still pays for all 100,000.

### Node V8 serialization

Node's `v8.serialize()` and `v8.deserialize()` provide a binary format for
JavaScript values. It can be compact and supports richer JavaScript values than
JSON.

It is not a lazy format. Deserialization creates the full object tree, so it has
the same basic memory shape as JSON for partial-access workloads. It is also
Node/V8-specific, which makes it less suitable as an interchange format.

### MessagePack and CBOR

MessagePack and CBOR libraries can be faster or smaller than JSON for some
datasets, especially repeated object shapes. They are useful candidates if the
main problem is compact binary encoding.

They are still normally whole-message decoders. Without an external line or
object index, they do not provide od-jsontag's lazy graph access pattern by
themselves.

One possible future direction is a pluggable od-jsontag line codec:

```text
line index -> byte range -> decode one MessagePack/CBOR object
```

That could keep the lazy architecture while replacing the per-line text payload.

### SQLite or embedded databases

SQLite and embedded databases are better when you need:

- queries;
- transactions;
- indexes;
- updates without rewriting serialized files;
- filtering and aggregation.

The tradeoff is a different programming model. od-jsontag is for object graph
access through proxies, not database queries.

### Columnar formats

Columnar formats are excellent when you scan a few properties across many rows.
od-jsontag is object-oriented: it is optimized for reaching objects and following
references lazily.

If your workload is:

```js
for (const item of items) {
  total += item.price
}
```

over millions of rows, a columnar format may be a better fit. If your workload
is:

```js
root.sections[10].children[3].title
```

od-jsontag is closer to the shape of the access pattern.

## Practical Guidance

Choose JSON when:

- full parse time is acceptable;
- memory for the full object tree is acceptable;
- simplicity matters most.

Choose od-jsontag without an index when:

- you want lazy object bodies but do not have a line index yet;
- scanning the file once is acceptable;
- the dataset is reused enough that proxy creation cost is not a problem.

Choose od-jsontag with a `SharedArrayBuffer` and index when:

- you can keep the data bytes in memory;
- you want fast lazy access;
- workers share the same serialized bytes;
- you repeatedly open the same dataset.

Choose od-jsontag with a file descriptor and index when:

- the data file is too large to keep in memory;
- you touch a small subset of objects;
- slightly slower random access is acceptable.

Do not choose od-jsontag solely for raw parse speed. Choose it when avoiding work
is more valuable than making a full parse faster.

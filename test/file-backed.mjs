import tap from 'tap'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import assert from 'node:assert/strict'
import {
    closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import Parser from '../src/parse.mjs'
import serialize, * as serialization from '../src/serialize.mjs'
import {getIndex, previous, isChanged} from '../src/symbols.mjs'

function fixture(bodies, first = 0) {
    const chunks = []
    const index = {}
    let offset = 0
    if (first) {
        const jump = Buffer.from(`+${first}\n`)
        chunks.push(jump)
        offset = jump.length
    }
    for (const [i, body] of bodies.entries()) {
        const bytes = Buffer.from(`(${Buffer.byteLength(body)})${body}`)
        index[first + i] = [offset, offset + bytes.length]
        chunks.push(bytes, Buffer.from('\n'))
        offset += bytes.length + 1
    }
    return {bytes: Buffer.concat(chunks), index}
}
const base = () => fixture([
    '{"items":[~1-2]}', '{"name":"one"}', '{"name":"two"}'
])
function store(t, data = base(), immutable = true) {
    const directory = mkdtempSync(path.join(tmpdir(), 'od-file-test-'))
    const file = path.join(directory, 'data.odjt')
    writeFileSync(file, data.bytes)
    const fd = openSync(file, 'r')
    t.teardown(() => {
        closeSync(fd)
        rmSync(directory, {recursive: true, force: true})
    })
    const parser = new Parser(undefined, immutable)
    const root = parser.parse(fd, Object.assign([], data.index))
    return {parser, root, fd, directory, data}
}

tap.test('file-backed reads and full serialization preserve unread records', t => {
    const {root} = store(t)
    const bytes = serialize(root)
    const copy = new Parser().parse(bytes)
    t.equal(copy.items.length, 2)
    t.equal(copy.items[0]?.name, 'one')
    t.equal(copy.items[1]?.name, 'two')
    t.end()
})

tap.test('new object IDs follow the entire indexed record space', t => {
    const {root} = store(t, base(), false)
    root.added = {name: 'new'}
    t.equal(root.added[getIndex], 3)
    t.equal(root.items[0].name, 'one')
    t.equal(root.items[1].name, 'two')
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.added.name, 'new')
    t.equal(copy.items[0].name, 'one')
    t.end()
})

tap.test('buffer patches preserve unread file-backed records and live identity', t => {
    const {root, parser} = store(t)
    const first = root.items[0]
    parser.parse(fixture(['{"name":"updated"}'], 1).bytes)
    t.equal(root.items[0], first)
    t.equal(first.name, 'updated')
    t.equal(root.items[1]?.name, 'two')
    t.end()
})

tap.test('sparse indexed files overlay by record number', t => {
    const {root, parser, fd, data, directory} = store(t)
    t.doesNotThrow(() => parser.parse(fd, Object.assign([], data.index)))
    const patch = fixture(['{"name":"updated"}'], 1)
    const file = path.join(directory, 'patch.odjt')
    writeFileSync(file, patch.bytes)
    const patchFd = openSync(file, 'r')
    t.teardown(() => closeSync(patchFd))
    parser.parse(patchFd, patch.index)
    t.equal(root.items[0].name, 'updated')
    t.equal(root.items[1].name, 'two')
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.items[0].name, 'updated')
    t.equal(copy.items[1].name, 'two')
    t.end()
})

tap.test('file index JSON objects and payload-only offsets are supported', t => {
    const data = base()
    const {fd, directory} = store(t, data)
    const payload = Object.fromEntries(Object.entries(data.index).map(([i, range]) => {
        const start = data.bytes.indexOf(41, range[0]) + 1
        return [i, [start, range[1]]]
    }))
    for (const index of [payload, JSON.stringify(payload)]) {
        const root = new Parser().parse(fd, index)
        t.equal(root.items[1].name, 'two')
    }
    const file = path.join(directory, 'index.json')
    writeFileSync(file, JSON.stringify(payload))
    t.equal(new Parser().parse(fd, file).items[1].name, 'two')
    t.end()
})

tap.test('read-only arrays and descriptors enforce the property policy', t => {
    const {root, parser} = store(t)
    t.throws(() => Object.defineProperty(root.items, '0', {value: 'changed'}))
    parser.meta.access = (object, property) => property !== '0'
    t.equal(root.items[0], undefined)
    t.equal(Object.getOwnPropertyDescriptor(root.items, '0')?.value, undefined)
    t.equal('0' in root.items, false)
    t.notOk(Object.keys(root.items).includes('0'))
    t.end()
})

tap.test('object descriptors do not expose denied properties', t => {
    const parser = new Parser()
    parser.meta.access = (object, property) => property !== 'secret'
    const root = parser.parse(fixture(['{"secret":"hidden","public":"ok"}']).bytes)
    t.equal(root.secret, undefined)
    t.equal(Object.getOwnPropertyDescriptor(root, 'secret')?.value, undefined)
    t.same(Object.keys(root), ['public'])
    t.end()
})

tap.test('mutable defineProperty is tracked and serialized', t => {
    const {root, parser} = store(t, base(), false)
    Object.defineProperty(root.items, '0', {
        value: {name: 'changed'}, configurable: true, writable: true,
        enumerable: true
    })
    t.equal(root[isChanged], true)
    const bytes = serialize(root, {changes: true})
    const copyParser = new Parser()
    const copy = copyParser.parse(base().bytes)
    copyParser.parse(bytes)
    t.equal(copy.items[0].name, 'changed')
    t.equal(copy.items[1].name, 'two')
    t.equal(parser.immutable, false)
    t.end()
})

tap.test('indexed reads reject invalid bounds and false framing', t => {
    const {fd, data} = store(t)
    for (const range of [[-1, 20], [20, 0], [0.5, 20], [0, NaN], [0, Infinity]]) {
        t.throws(() => new Parser().parse(fd, [range]))
    }
    const invalid = [[0, data.bytes.length + 100]]
    t.throws(() => new Parser().parse(fd, invalid))
    for (const text of ['(999){"name":"one"}', '(2){"name":"one"}', '(){"name":"one"}', '{}garbage']) {
        const bytes = Buffer.from(text)
        t.throws(() => new Parser().parse(bytes, [[0, bytes.length]]))
    }
    t.end()
})

tap.test('a committed patch refreshes previous on the next edit', t => {
    const {root, parser} = store(t, fixture(['{"name":"one"}']), false)
    root.name = 'two'
    parser.parse(serialize(root, {changes: true}))
    root.name = 'three'
    t.equal(root[previous].name, 'two')
    t.end()
})

tap.test('bounded read cache preserves live proxy identity and array reads', t => {
    const bodies = ['{"items":[~1-1000]}']
    for (let i = 0; i < 1000; i++) {
        bodies.push(JSON.stringify({name: `item ${i}`, nested: [i]}))
    }
    const {root, parser} = store(t, fixture(bodies))
    parser.cacheSize = 8
    const first = root.items[0]
    const nested = first.nested
    let total = 0
    for (const item of root.items) {
        total += item.nested[0]
    }
    t.equal(total, 999 * 1000 / 2)
    t.equal(root.items[0], first)
    t.equal(first.name, 'item 0')
    t.equal(nested[0], 0)
    t.ok(parser.cacheInfo().residentRecords <= 8)
    parser.clearCache()
    t.equal(parser.cacheInfo().residentRecords, 0)
    t.equal(first.name, 'item 0')
    t.end()
})

tap.test('streamed serialization preserves sparse records without full output allocation', t => {
    const {root, directory} = store(t)
    t.type(serialization.serializeChunks, 'function')
    if (typeof serialization.serializeChunks === 'function') {
        const file = path.join(directory, 'copy.odjt')
        const chunks = [...serialization.serializeChunks(root)]
        writeFileSync(file, Buffer.concat(chunks))
        assert.deepEqual(readFileSync(file), Buffer.from(serialize(root)))
        const copy = new Parser().parse(readFileSync(file))
        t.equal(copy.items[1].name, 'two')
    }
    t.end()
})

tap.test('short file reads are completed and truncation fails explicitly', t => {
    const {root, fd} = store(t)
    const originalRead = fs.readSync
    let calls = 0
    try {
        fs.readSync = (file, bytes, offset, length, position) => {
            if (file === fd) {
                calls++
                length = Math.min(length, 3)
            }
            return originalRead(file, bytes, offset, length, position)
        }
        syncBuiltinESMExports()
        t.equal(root.items[0].name, 'one')
        t.ok(calls > 1)
        fs.readSync = file => {
            assert.equal(file, fd)
            return 0
        }
        syncBuiltinESMExports()
        t.throws(() => root.items[1].name, /Unexpected end of file/)
        fs.readSync = () => {
            throw Object.assign(new Error('injected read failure'), {code: 'EIO'})
        }
        syncBuiltinESMExports()
        t.throws(() => root.items[1].name, {code: 'EIO'})
    }
    finally {
        fs.readSync = originalRead
        syncBuiltinESMExports()
    }
    t.equal(root.items[1].name, 'two')
    t.end()
})

tap.test('Unicode byte ranges and escaped surrogate pairs survive streamed roundtrip', t => {
    const data = fixture([
        '{"items":[~1-2]}',
        '{"name":"Padmé 𠮷 €"}',
        '{"name":"\\uD842\\uDFB7"}'
    ])
    const {root, parser} = store(t, data)
    parser.cacheSize = 1
    t.equal(root.items[0].name, 'Padmé 𠮷 €')
    t.equal(root.items[1].name, '𠮷')
    const bytes = Buffer.concat([...serialization.serializeChunks(root)])
    const copy = new Parser().parse(bytes)
    t.equal(copy.items[0].name, 'Padmé 𠮷 €')
    t.equal(copy.items[1].name, '𠮷')
    t.end()
})

tap.test('record identity and cyclic references survive eviction and overlays', t => {
    const {root, parser} = store(t, fixture([
        '{"first":~1,"second":~2}',
        '{"name":"one","other":~2}',
        '{"name":"two","other":~1}'
    ]))
    parser.cacheSize = 1
    const first = root.first
    const second = root.second
    t.equal(first.other, second)
    t.equal(second.other, first)
    parser.parse(fixture(['{"name":"changed","other":~2}'], 1).bytes)
    t.equal(first.name, 'changed')
    t.equal(second.other, first)
    t.end()
})

tap.test('sparse record numbers remain sparse during full serialization and allocation', t => {
    const bytes = Buffer.from('{"tail":~7}\n{"name":"seven"}')
    const boundary = bytes.indexOf(10)
    const index = {0: [0, boundary], 7: [boundary + 1, bytes.length]}
    const {root, parser} = store(t, {bytes, index}, false)
    root.new = {name: 'eight'}
    t.equal(root.new[getIndex], 8)
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.tail.name, 'seven')
    t.equal(copy.tail[getIndex], 7)
    t.equal(copy.new[getIndex], 8)
    t.throws(() => parser.clearCache(), /mutable/)
    parser.immutable = true
    t.throws(() => parser.clearCache(), /uncommitted/)
    t.equal(root.new.name, 'eight')
    t.end()
})

tap.test('only edited records appear in patches, even after read cache eviction', t => {
    const {root, parser} = store(t, base(), false)
    root.items[1].name = 'changed'
    const text = Buffer.from(serialize(root, {changes: true})).toString()
    t.equal(text, '+2\n(18){"name":"changed"}')
    parser.parse(Buffer.from(text))
    t.equal(Buffer.from(serialize(root, {changes: true})).length, 0)
    parser.immutable = true
    parser.clearCache()
    t.equal(root.items[1].name, 'changed')
    t.equal(Buffer.from(serialize(root, {changes: true})).length, 0)
    t.end()
})

tap.test('array mutation methods retain untouched references and track nested changes', t => {
    const {root} = store(t, base(), false)
    root.items.unshift(null)
    root.items.splice(1, 1, {name: 'replacement'})
    root.items.reverse()
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.items[0].name, 'two')
    t.equal(copy.items[1].name, 'replacement')
    t.equal(copy.items[2], null)
    t.end()
})

tap.test('invalid indexes cannot partially replace existing locations', t => {
    const {root, parser, fd} = store(t)
    t.throws(() => parser.parse(fd, {0: [0, 20], 1: [-1, 5]}))
    t.equal(root.items[1].name, 'two')
    t.throws(() => parser.parse(fd, {'-1': [0, 20]}))
    t.throws(() => parser.parse(fd, {'1.5': [0, 20]}))
    t.throws(() => parser.parse(fd, {0: [0]}))
    t.end()
})

tap.test('replacing metadata starts a new record space for reused command workers', t => {
    const parser = new Parser(undefined, false)
    let root = parser.parse(base().bytes)
    root.extra = {name: 'old session'}
    t.equal(root.extra[getIndex], 3)
    parser.meta = {index: {id: new Map()}, resultArray: []}
    root = parser.parse(base().bytes)
    root.extra = {name: 'new session'}
    t.equal(root.extra[getIndex], 3)
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.extra.name, 'new session')
    t.equal(copy.items.length, 2)
    t.end()
})

tap.test('self references and shared new objects retain record identity', t => {
    const {root} = store(t, base(), false)
    const added = {name: 'new'}
    added.self = added
    root.first = added
    root.second = added
    root.self = root
    t.equal(root.first, root.second)
    t.equal(root.first.self, root.first)
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.self, copy)
    t.equal(copy.first, copy.second)
    t.equal(copy.first.self, copy.first)
    t.end()
})

tap.test('read-only array searches do not allocate command records', t => {
    const {root, parser} = store(t)
    const count = parser.cacheInfo().records
    t.equal(root.items.includes({name: 'one'}), false)
    t.equal(root.items.indexOf({name: 'two'}), -1)
    t.equal(parser.cacheInfo().records, count)
    t.equal(serialize(root, {changes: true}).length, 0)
    t.end()
})

tap.test('previous snapshots expose values rather than internal line references', t => {
    const {root} = store(t, fixture([
        '{"item":~1,"items":[~1]}', '{"name":"one"}'
    ]), false)
    root.title = 'new'
    t.equal(root[previous].item.name, 'one')
    root.items.push({name: 'two'})
    t.equal(root.items[previous][0].name, 'one')
    t.equal(root.items[previous].length, 1)
    t.end()
})

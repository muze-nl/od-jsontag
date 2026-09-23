import tap from 'tap'
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

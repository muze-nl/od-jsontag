import tap from 'tap'
import Parser from '../src/parse.mjs'
import serialize from '../src/serialize.mjs'
import {fileSource, loadLineIndex} from '../src/node.mjs'
import {
    openSync, closeSync, writeFileSync, mkdtempSync, rmSync, fstatSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

const encoder = new TextEncoder()

function fixture(rows) {
    let length = 0
    const index = {}
    const chunks = []
    for (const [number, text] of Object.entries(rows)) {
        const bytes = encoder.encode(text + '\n')
        index[number] = [length, length + bytes.length - 1]
        chunks.push(bytes)
        length += bytes.length
    }
    const bytes = new Uint8Array(length)
    let at = 0
    for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.length
    }
    const reads = []
    const source = {
        byteLength: bytes.length,
        read(start, end) {
            reads.push([start, end])
            return bytes.slice(start, end)
        }
    }
    return {bytes, index, source, reads}
}

tap.test('custom sources stay lazy through reads, patches and serialization', t => {
    const base = fixture({
        0: '{"items":[~1-2]}',
        1: '{"name":"Padmé 𠮷","other":~2}',
        2: '{"name":"two","other":~1}'
    })
    const patch = fixture({1: '{"name":"changed","other":~2}'})
    const parser = new Parser()
    const root = parser.parse(base.source, base.index)
    t.same(base.reads, [base.index[0]])
    t.equal(root.items.length, 2)
    t.same(base.reads, [base.index[0]])
    const first = root.items[0]
    t.equal(first.name, 'Padmé 𠮷')
    t.same(base.reads, [base.index[0], base.index[1]])
    parser.parse(patch.source, patch.index)
    t.equal(root.items[0], first)
    t.equal(first.name, 'changed')
    t.same(patch.reads, [patch.index[1]])
    const copy = new Parser().parse(serialize(root))
    t.equal(copy.items[1].name, 'two')
    t.equal(copy.items[0].other, copy.items[1])
    t.equal(copy.items[1].other, copy.items[0])
    t.end()
})

tap.test('source failures remain visible and failed reads can be retried', t => {
    const base = fixture({0: '{"item":~1}', 1: '{"name":"one"}'})
    const originalRead = base.source.read
    const root = new Parser().parse(base.source, base.index)
    const failure = Object.assign(new Error('read failed'), {code: 'EIO'})
    base.source.read = () => { throw failure }
    t.throws(() => root.item.name, failure)
    for (const result of [undefined, 'bytes', new ArrayBuffer(14), Promise.resolve()]) {
        base.source.read = () => result
        t.throws(() => root.item.name, /must return a Uint8Array/)
    }
    for (const size of [0, 13, 15]) {
        base.source.read = () => new Uint8Array(size)
        t.throws(() => root.item.name, /Incomplete byte range/)
    }
    base.source.read = originalRead
    t.equal(root.item.name, 'one')
    t.end()
})

tap.test('invalid source bounds fail before reading or replacing records', t => {
    const base = fixture({0: '{"name":"original"}'})
    const parser = new Parser()
    const root = parser.parse(base.source, base.index)
    const replacement = fixture({0: '{"name":"replacement"}'})
    for (const size of [-1, NaN, Infinity, 1.5]) {
        const source = {...replacement.source, byteLength: size}
        t.throws(() => parser.parse(source, replacement.index))
    }
    t.throws(() => parser.parse(replacement.source))
    t.throws(() => parser.parse(replacement.source, {
        0: replacement.index[0], 1: [0, replacement.bytes.length + 1]
    }))
    t.same(replacement.reads, [])
    t.equal(root.name, 'original')
    t.throws(() => new Parser().parse(7, base.index))
    t.throws(() => new Parser().parse(base.source, '/no/index/files/in/core'))
    t.end()
})

tap.test('Node adapters work with the portable parser and leave handles owned', t => {
    const base = fixture({0: '{"item":~1}', 1: '{"name":"one"}'})
    const directory = mkdtempSync(path.join(tmpdir(), 'od-source-'))
    t.teardown(() => rmSync(directory, {recursive: true, force: true}))
    const file = path.join(directory, 'data.odjt')
    const indexFile = path.join(directory, 'index.json')
    writeFileSync(file, base.bytes)
    writeFileSync(indexFile, JSON.stringify(base.index))
    const fd = openSync(file, 'r')
    const indexFd = openSync(indexFile, 'r')
    const wrappedFd = openSync(indexFile, 'r')
    try {
        const source = fileSource({fd})
        for (const input of [indexFile, indexFd, {fd: wrappedFd}]) {
            const root = new Parser().parse(source, loadLineIndex(input))
            t.equal(root.item.name, 'one')
        }
        t.equal(fstatSync(fd).size, base.bytes.length)
        t.same(source.read(0, 0), new Uint8Array())
        for (const range of [[-1, 1], [0, Infinity], [2, 1], [0, 1.5]]) {
            t.throws(() => source.read(...range), /Invalid file byte range/)
        }
        t.throws(() => fileSource('path'), /requires a file descriptor/)
    }
    finally {
        closeSync(fd)
        closeSync(indexFd)
        closeSync(wrappedFd)
    }
    t.end()
})

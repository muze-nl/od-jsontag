import assert from 'node:assert/strict'
import {
    closeSync, mkdtempSync, openSync, rmSync, writeSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setImmediate} from 'node:timers/promises'
import Parser from '../src/node.mjs'

function option(name, fallback) {
    const prefix = `--${name}=`
    const supplied = process.argv.find(value => value.startsWith(prefix))
    return supplied ? Number(supplied.slice(prefix.length)) : fallback
}
const count = option('objects', 20000)
const payload = option('payload', 128)
const directory = mkdtempSync(path.join(tmpdir(), 'od-retention-'))
const file = path.join(directory, 'data.odjt')
const index = []
let offset = 0
let fd
try {
    fd = openSync(file, 'w')
    const append = body => {
        const bytes = Buffer.from(`(${Buffer.byteLength(body)})${body}\n`)
        index.push([offset, offset + bytes.length - 1])
        let written = 0
        while (written < bytes.length) {
            written += writeSync(fd, bytes, written, bytes.length - written)
        }
        offset += bytes.length
    }
    append(`{"items":[~1-${count}]}`)
    for (let i = 0; i < count; i++) {
        append(JSON.stringify({value: i, body: 'x'.repeat(payload)}))
    }
    closeSync(fd)
    fd = openSync(file, 'r')
    const parser = new Parser()
    const start = performance.now()
    const root = parser.parse(fd, index)
    const openMs = performance.now() - start
    const items = root.items
    const samples = []
    async function sample(phase) {
        // WeakRefs remain alive for the current JS job. Measure after a turn
        // boundary, with the parser and root still live.
        await setImmediate()
        global.gc?.()
        const usage = process.memoryUsage()
        samples.push({phase, ...parser.cacheInfo(), heapBytes: usage.heapUsed,
            bufferBytes: usage.arrayBuffers})
        assert.ok(parser.cacheInfo().residentRecords <= parser.cacheSize)
    }
    await sample('open')
    const scanStart = performance.now()
    let sum = 0
    for (let i = 0; i < count; i++) {
        sum += items[i].value
        if ((i + 1) % 1000 === 0) {
            await setImmediate()
        }
        if (i + 1 === Math.floor(count / 2)) {
            await sample('half scan')
        }
    }
    const scanMs = performance.now() - scanStart
    assert.equal(sum, count * (count - 1) / 2)
    await sample('full scan')
    parser.clearCache()
    await sample('cleared')
    assert.equal(items[0].value, 0)
    assert.equal(items[count - 1].value, count - 1)
    console.log(JSON.stringify({count, payload, fileBytes: offset, openMs,
        scanMs, checksum: sum, samples}, null, 2))
}
finally {
    if (fd !== undefined) {
        closeSync(fd)
    }
    rmSync(directory, {recursive: true, force: true})
}

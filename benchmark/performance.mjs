import {closeSync, openSync, writeFileSync} from 'node:fs'
import {deserialize as v8Deserialize, serialize as v8Serialize} from 'node:v8'
import Parser from '../src/parse.mjs'

const encoder = new TextEncoder()

const scenarios = [
  'json_parse_full',
  'v8_deserialize_full',
  'od_sab_scan_root',
  'od_sab_index_root',
  'od_sab_index_access',
  'od_file_index_access'
]

function option(name, fallback) {
  const prefix = `--${name}=`
  const arg = process.argv.find(arg => arg.startsWith(prefix))
  if (!arg) {
    return fallback
  }
  return Number(arg.slice(prefix.length))
}

function stringOption(name) {
  const prefix = `--${name}=`
  const arg = process.argv.find(arg => arg.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : undefined
}

const objectCount = option('objects', 100000)
const accessCount = option('accessed', 1000)
const runs = option('runs', 5)
const scenario = stringOption('scenario')
  ?? process.argv.slice(2).find(arg => !arg.startsWith('--'))

function objectBody(i) {
  return '{"id":' + i
    + ',"name":"Item ' + i + '"'
    + ',"group":' + (i % 100)
    + ',"active":' + (i % 2 === 0)
    + ',"score":' + (i / 10)
    + ',"description":"Description ' + i + '"}'
}

function makeJson() {
  const parts = new Array(objectCount)
  for (let i = 0; i < objectCount; i++) {
    parts[i] = objectBody(i)
  }
  return '{"items":[' + parts.join(',') + ']}'
}

function makePlainObject() {
  const items = new Array(objectCount)
  for (let i = 0; i < objectCount; i++) {
    items[i] = {
      id: i,
      name: 'Item ' + i,
      group: i % 100,
      active: i % 2 === 0,
      score: i / 10,
      description: 'Description ' + i
    }
  }
  return {items}
}

function encodeLine(body) {
  return '(' + encoder.encode(body).length + ')' + body
}

function makeOdText() {
  const lines = new Array(objectCount + 1)
  lines[0] = encodeLine('{"items":[~1-' + objectCount + ']}')
  for (let i = 0; i < objectCount; i++) {
    lines[i + 1] = encodeLine(objectBody(i))
  }
  return lines.join('\n')
}

function lineIndex(strData) {
  const buffer = encoder.encode(strData)
  const result = []
  let start = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) {
      result.push([start, i])
      start = i + 1
    }
  }
  if (start < buffer.length) {
    result.push([start, buffer.length])
  }
  return result
}

function stringToSAB(strData) {
  const buffer = encoder.encode(strData)
  const sab = new SharedArrayBuffer(buffer.length)
  const view = new Uint8Array(sab)
  view.set(buffer, 0)
  return view
}

function positions() {
  return Array.from({length: accessCount}, (_, i) => (i * 97) % objectCount)
}

function forceGc() {
  global.gc?.()
  global.gc?.()
}

function memory() {
  forceGc()
  const m = process.memoryUsage()
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers
  }
}

function diff(start, end) {
  return {
    rss: end.rss - start.rss,
    heapUsed: end.heapUsed - start.heapUsed,
    external: end.external - start.external,
    arrayBuffers: end.arrayBuffers - start.arrayBuffers
  }
}

function timed(fn) {
  const start = process.hrtime.bigint()
  const result = fn()
  const end = process.hrtime.bigint()
  return {
    ms: Number(end - start) / 1e6,
    result
  }
}

function finish(label, setup, run) {
  forceGc()
  const processStart = memory()
  const input = setup()
  forceGc()
  const inputReady = memory()
  const measured = timed(() => run(input))

  // Keep both input and result live until after measurement.
  globalThis.keepAlive = {input, result: measured.result}

  const after = memory()
  console.log(JSON.stringify({
    label,
    node: process.version,
    objects: objectCount,
    accessed: accessCount,
    inputBytes: input.inputBytes,
    indexBytes: input.indexBytes ?? 0,
    ms: measured.ms,
    inputMemory: diff(processStart, inputReady),
    operationMemory: diff(inputReady, after),
    totalMemory: diff(processStart, after),
    checksum: measured.result?.checksum ?? measured.result
  }))
}

function runScenario(name) {
  if (name === 'json_parse_full') {
    finish('JSON.parse full dataset', () => {
      const json = makeJson()
      return {
        json,
        inputBytes: Buffer.byteLength(json)
      }
    }, ({json}) => {
      const root = JSON.parse(json)
      let checksum = 0
      for (const pos of positions()) {
        checksum += root.items[pos].score
      }
      return {root, checksum}
    })
    return
  }

  if (name === 'v8_deserialize_full') {
    finish('v8.deserialize full dataset', () => {
      let value = makePlainObject()
      const buffer = v8Serialize(value)
      value = null
      forceGc()
      return {
        buffer,
        inputBytes: buffer.byteLength
      }
    }, ({buffer}) => {
      const root = v8Deserialize(buffer)
      let checksum = 0
      for (const pos of positions()) {
        checksum += root.items[pos].score
      }
      return {root, checksum}
    })
    return
  }

  if (name === 'od_sab_scan_root') {
    finish('od-jsontag SAB scan root', () => {
      let text = makeOdText()
      const buffer = stringToSAB(text)
      const inputBytes = buffer.byteLength
      text = null
      forceGc()
      return {buffer, inputBytes}
    }, ({buffer}) => {
      const parser = new Parser()
      const root = parser.parse(buffer)
      return {root, checksum: root.items.length}
    })
    return
  }

  if (name === 'od_sab_index_root') {
    finish('od-jsontag SAB indexed root', () => {
      let text = makeOdText()
      const index = lineIndex(text)
      const indexBytes = Buffer.byteLength(JSON.stringify(index))
      const buffer = stringToSAB(text)
      const inputBytes = buffer.byteLength
      text = null
      forceGc()
      return {buffer, index, inputBytes, indexBytes}
    }, ({buffer, index}) => {
      const parser = new Parser()
      const root = parser.parse(buffer, index)
      return {root, checksum: root.items.length}
    })
    return
  }

  if (name === 'od_sab_index_access') {
    finish('od-jsontag SAB indexed + partial access', () => {
      let text = makeOdText()
      const index = lineIndex(text)
      const indexBytes = Buffer.byteLength(JSON.stringify(index))
      const buffer = stringToSAB(text)
      const inputBytes = buffer.byteLength
      text = null
      forceGc()
      return {buffer, index, inputBytes, indexBytes}
    }, ({buffer, index}) => {
      const parser = new Parser()
      const root = parser.parse(buffer, index)
      let checksum = 0
      for (const pos of positions()) {
        checksum += root.items[pos].score
      }
      return {root, checksum}
    })
    return
  }

  if (name === 'od_file_index_access') {
    finish('od-jsontag file indexed + partial access', () => {
      let text = makeOdText()
      const index = lineIndex(text)
      const indexBytes = Buffer.byteLength(JSON.stringify(index))
      const inputBytes = Buffer.byteLength(text)
      const path = '/tmp/od-jsontag-performance-' + process.pid + '.odjt'
      writeFileSync(path, text)
      const fd = openSync(path, 'r')
      text = null
      forceGc()
      return {fd, index, inputBytes, indexBytes}
    }, ({fd, index}) => {
      try {
        const parser = new Parser()
        const root = parser.parse(fd, index)
        let checksum = 0
        for (const pos of positions()) {
          checksum += root.items[pos].score
        }
        return {root, checksum}
      } finally {
        closeSync(fd)
      }
    })
    return
  }

  throw new Error('Unknown scenario: ' + name)
}

function median(rows) {
  const sorted = [...rows].sort((a, b) => a.ms - b.ms)
  return sorted[Math.floor(sorted.length / 2)]
}

function mib(bytes) {
  return bytes / 1024 / 1024
}

function formatMib(bytes) {
  return mib(bytes).toFixed(2) + ' MiB'
}

function formatMs(ms) {
  return ms.toFixed(2) + ' ms'
}

function printMarkdown(rows) {
  console.log('# od-jsontag Performance Benchmark')
  console.log()
  console.log('Objects: `' + objectCount + '`')
  console.log('Accessed objects: `' + accessCount + '`')
  console.log('Runs per scenario: `' + runs + '`')
  console.log('Node: `' + rows[0].node + '`')
  console.log()
  console.log('## Time')
  console.log()
  console.log('| Scenario | Median time |')
  console.log('| --- | ---: |')
  for (const row of rows) {
    console.log('| ' + row.label + ' | ' + formatMs(row.ms) + ' |')
  }
  console.log()
  console.log('## Retained Memory')
  console.log()
  console.log('| Scenario | RSS delta | Heap delta | ArrayBuffer delta | External delta |')
  console.log('| --- | ---: | ---: | ---: | ---: |')
  for (const row of rows) {
    console.log('| ' + row.label
      + ' | ' + formatMib(row.totalMemory.rss)
      + ' | ' + formatMib(row.totalMemory.heapUsed)
      + ' | ' + formatMib(row.totalMemory.arrayBuffers)
      + ' | ' + formatMib(row.totalMemory.external)
      + ' |')
  }
  console.log()
  console.log('## Input Size')
  console.log()
  console.log('| Scenario | Data bytes | Index bytes |')
  console.log('| --- | ---: | ---: |')
  for (const row of rows) {
    console.log('| ' + row.label
      + ' | ' + formatMib(row.inputBytes)
      + ' | ' + formatMib(row.indexBytes)
      + ' |')
  }
}

function runAll() {
  const rows = []

  for (const name of scenarios) {
    const samples = []
    for (let i = 0; i < runs; i++) {
      samples.push(captureScenario(name))
    }
    rows.push(median(samples))
  }

  printMarkdown(rows)
}

function captureScenario(name) {
  const logs = []
  const originalLog = console.log
  try {
    console.log = message => {
      logs.push(message)
    }
    runScenario(name)
  } finally {
    console.log = originalLog
  }
  globalThis.keepAlive = undefined
  if (!logs[0]) {
    throw new Error(`No benchmark output for ${name}`)
  }
  return JSON.parse(logs[0])
}

if (scenario) {
  runScenario(scenario)
} else {
  runAll()
}

import tap from 'tap'
import {build} from 'esbuild'
import {getQuickJS} from 'quickjs-emscripten'
import {fileURLToPath} from 'node:url'
import {
    mkdtempSync, writeFileSync, openSync, closeSync, rmSync
} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileSource} from '../src/node.mjs'

// The embedding supplies Web APIs separately from the portable library.
// These test adapters copy only strings and bytes across the engine boundary.
function installEncoding(vm) {
    function expose(name, fn) {
        const handle = vm.newFunction(name, fn)
        vm.setProp(vm.global, name, handle)
        handle.dispose()
    }
    expose('__encode', text => {
        const bytes = new TextEncoder().encode(vm.getString(text))
        return vm.newArrayBuffer(bytes)
    })
    expose('__decode', (buffer, offset, length) => {
        const bytes = vm.getArrayBuffer(buffer)
        try {
            const start = vm.getNumber(offset)
            const end = start + vm.getNumber(length)
            return vm.newString(new TextDecoder().decode(
                bytes.value.subarray(start, end)
            ))
        }
        finally {
            bytes.dispose()
        }
    })
    return `
        globalThis.TextEncoder = class {
            encode(text) { return new Uint8Array(__encode(String(text))) }
        };
        globalThis.TextDecoder = class {
            decode(bytes) {
                return __decode(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            }
        };
    `
}

tap.test('portable bundle parses indexed host bytes inside QuickJS', async t => {
    const bundle = await build({
        stdin: {
            contents: `
                import Parser from './src/parse.mjs';
                import serialize from './src/serialize.mjs';
                import JSONTag from '@muze-nl/jsontag';
                globalThis.library = {Parser, serialize, JSONTag};
            `,
            resolveDir: fileURLToPath(new URL('..', import.meta.url))
        },
        bundle: true,
        platform: 'neutral',
        mainFields: ['main'],
        format: 'iife',
        write: false
    })
    // No Node aliases or filesystem shims are used to build the guest bundle.
    const QuickJS = await getQuickJS()
    const vm = QuickJS.newContext()
    t.teardown(() => vm.dispose())
    vm.runtime.setMemoryLimit(64 * 1024 * 1024)
    let deadline = Date.now() + 5000
    vm.runtime.setInterruptHandler(() => Date.now() > deadline)
    function evaluate(code) {
        deadline = Date.now() + 5000
        const result = vm.evalCode(code)
        const handle = result.error || result.value
        try {
            const value = vm.dump(handle)
            if (result.error) {
                throw new Error(JSON.stringify(value))
            }
            return value
        }
        finally {
            handle.dispose()
        }
    }
    evaluate(installEncoding(vm))
    evaluate('globalThis.SharedArrayBuffer = undefined;')
    evaluate(bundle.outputFiles[0].text)
    t.equal(evaluate('typeof process'), 'undefined')
    t.equal(evaluate('typeof require'), 'undefined')
    t.equal(evaluate(`new library.Parser().parse(
        '(17){"name":"Padmé"}'
    ).name`), 'Padmé')

    const directory = mkdtempSync(path.join(tmpdir(), 'od-quickjs-'))
    const handles = []
    t.teardown(() => {
        for (const fd of handles) {
            closeSync(fd)
        }
        rmSync(directory, {recursive: true, force: true})
    })
    function createSource(name, rows) {
        const index = {}
        const chunks = []
        let offset = 0
        for (const [number, body] of Object.entries(rows)) {
            const text = `(${Buffer.byteLength(body)})${body}`
            const bytes = Buffer.from(text + '\n')
            index[number] = [offset, offset + bytes.length - 1]
            offset += bytes.length
            chunks.push(bytes)
        }
        const file = path.join(directory, name)
        writeFileSync(file, Buffer.concat(chunks))
        const fd = openSync(file, 'r')
        handles.push(fd)
        return {source: fileSource(fd), index}
    }
    const sources = [
        createSource('base.odjt', {
            0: '{"items":[~1-2]}',
            1: '<object id="first">{"name":"Padmé 𠮷","other":~2}',
            2: '{"name":"two","other":~1}'
        }),
        createSource('patch.odjt', {
            1: '<object id="first">{"name":"changed","other":~2}'
        })
    ]
    const reads = []
    const read = vm.newFunction('readRange', (id, startHandle, endHandle) => {
        const number = vm.getNumber(id)
        const entry = sources[number]
        const start = vm.getNumber(startHandle)
        const end = vm.getNumber(endHandle)
        if (!entry || !Object.values(entry.index).some(range => {
            return range[0] === start && range[1] === end
        })) {
            throw new Error('Unknown source or byte range')
        }
        reads.push({number, start, end})
        return vm.newArrayBuffer(entry.source.read(start, end))
    })
    vm.setProp(vm.global, 'readRange', read)
    read.dispose()
    evaluate(`
        function source(number, byteLength) {
            return {byteLength, read(start, end) {
                return new Uint8Array(readRange(number, start, end));
            }};
        }
        globalThis.parser = new library.Parser();
        globalThis.root = parser.parse(
            source(0, ${sources[0].source.byteLength}),
            ${JSON.stringify(sources[0].index)}
        );
        void 0;
    `)
    t.equal(reads.length, 1, 'only the root was read')
    t.equal(evaluate('root.items.length'), 2)
    t.equal(reads.length, 1, 'array length does not fetch records')
    t.equal(evaluate('root.items[0].name'), 'Padmé 𠮷')
    t.equal(reads.length, 2, 'one property access reads one record')
    t.same(evaluate('root.items.map(item => item.name)'), ['Padmé 𠮷', 'two'])
    t.equal(reads.length, 3)
    t.equal(evaluate('root.items[0].other === root.items[1]'), true)
    t.equal(evaluate('root.items[1].other === root.items[0]'), true)
    t.equal(evaluate('library.JSONTag.getAttribute(root.items[0], "id")'), 'first')
    t.equal(evaluate(`(() => {
        try { root.items[0].name = 'bad'; } catch (_) {}
        return root.items[0].name;
    })()`), 'Padmé 𠮷')
    evaluate(`parser.meta.access = (object, key) => key !== 'name'; void 0;`)
    t.equal(evaluate('root.items[0].name'), undefined)
    t.equal(evaluate(`Object.keys(root.items[0]).includes('name')`), false)
    evaluate(`parser.meta.access = undefined; parser.cacheSize = 1; void 0;`)
    evaluate(`
        globalThis.first = root.items[0];
        parser.parse(source(1, ${sources[1].source.byteLength}),
            ${JSON.stringify(sources[1].index)});
        void 0;
    `)
    t.equal(evaluate('first === root.items[0]'), true)
    t.equal(evaluate('first.name'), 'changed')
    t.equal(evaluate('root.items[1].other === first'), true)
    t.equal(evaluate(`(() => {
        const bytes = library.serialize(root);
        const copy = new library.Parser().parse(bytes);
        return bytes.buffer instanceof ArrayBuffer &&
            copy.items[0].name === 'changed' &&
            copy.items[1].other === copy.items[0];
    })()`), true, 'serialization works without SharedArrayBuffer')
})

import {fstatSync, readFileSync, readSync} from 'node:fs'
import Parser from './parse.mjs'
import {parseLineIndex} from './records.mjs'

function fileDescriptor(input) {
    if (Number.isSafeInteger(input) && input >= 0) {
        return input
    }
    if (Number.isSafeInteger(input?.fd) && input.fd >= 0) {
        return input.fd
    }
    return undefined
}

// The caller owns the descriptor and must keep it open while proxies use it.
export function fileSource(input) {
    const fd = fileDescriptor(input)
    if (fd === undefined) {
        throw new TypeError('fileSource requires a file descriptor')
    }
    const byteLength = fstatSync(fd).size
    return {
        byteLength,
        read(start, end) {
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
                start < 0 || end < start || end > byteLength) {
                throw new RangeError('Invalid file byte range')
            }
            const bytes = new Uint8Array(end - start)
            let offset = 0
            while (offset < bytes.length) {
                const count = readSync(
                    fd, bytes, offset, bytes.length - offset, start + offset
                )
                if (count === 0) {
                    throw new Error('Unexpected end of file')
                }
                offset += count
            }
            return bytes
        }
    }
}

export function loadLineIndex(index) {
    const fd = fileDescriptor(index)
    if (fd !== undefined) {
        return parseLineIndex(readFileSync(fd, 'utf8'))
    }
    if (typeof index === 'string' || index instanceof String) {
        const text = String(index).trimStart()
        if (!text.startsWith('[') && !text.startsWith('{')) {
            return parseLineIndex(readFileSync(String(index), 'utf8'))
        }
    }
    return parseLineIndex(index)
}

// Node's convenience entry point preserves descriptor/path inputs while the
// default parser remains independent of filesystem and module-loader APIs.
export default class NodeParser extends Parser {
    parse(input, lineIndex) {
        if (lineIndex) {
            if (fileDescriptor(input) !== undefined) {
                input = fileSource(input)
            }
            lineIndex = loadLineIndex(lineIndex)
        }
        return super.parse(input, lineIndex)
    }
}

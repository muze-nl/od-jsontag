import {fstatSync, readFileSync, readSync} from 'node:fs'

const decoder = new TextDecoder()

export function fileDescriptor(input) {
    if (Number.isInteger(input) && input >= 0) {
        return input
    }
    if (Number.isInteger(input?.fd) && input.fd >= 0) {
        return input.fd
    }
    return undefined
}

export function parseLineIndex(index) {
    if (index instanceof Uint8Array) {
        index = decoder.decode(index)
    }
    else if (fileDescriptor(index) !== undefined) {
        index = readFileSync(fileDescriptor(index), 'utf8')
    }
    if (typeof index === 'string' || index instanceof String) {
        const text = String(index).trimStart()
        if (text.startsWith('[') || text.startsWith('{')) {
            index = JSON.parse(text)
        }
        else {
            index = JSON.parse(readFileSync(String(index), 'utf8'))
        }
    }
    if (!index || typeof index !== 'object') {
        throw new TypeError('line index must be an array or record-number object')
    }
    return index
}

function sourceSize(input) {
    const fd = fileDescriptor(input)
    if (fd !== undefined) {
        return fstatSync(fd).size
    }
    if (input instanceof Uint8Array) {
        return input.byteLength
    }
    throw new TypeError('indexed input must be a Uint8Array or file descriptor')
}

// This catalog describes the complete record space, independently of the
// subset that has been read or has a live JavaScript proxy.
export default class Records {
    constructor() {
        this.positions = new Map()
        this.length = 0
    }

    indexedPositions(input, index) {
        index = parseLineIndex(index)
        const size = sourceSize(input)
        const entries = []
        for (const [key, range] of Object.entries(index)) {
            if (range === null) {
                continue
            }
            const number = Number(key)
            if (!Number.isInteger(number) || number < 0 ||
                number >= 0xffffffff || String(number) !== key) {
                throw new RangeError(`Invalid record number: ${key}`)
            }
            if (!Array.isArray(range) || range.length !== 2) {
                throw new TypeError(`Invalid byte range for record ${key}`)
            }
            const [start, end] = range
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
                start < 0 || end <= start || end > size) {
                throw new RangeError(`Invalid byte range for record ${key}`)
            }
            entries.push([number, {input, start, end, indexed: true}])
        }
        return entries
    }

    set(index, location) {
        this.positions.set(index, location)
        this.length = Math.max(this.length, index + 1)
    }

    allocate() {
        return this.length++
    }

    has(index) {
        return this.positions.has(index)
    }

    read(index) {
        const location = this.positions.get(index)
        if (!location) {
            throw new RangeError(`Missing record ${index}`)
        }
        const {input, start, end, indexed} = location
        const fd = fileDescriptor(input)
        let bytes
        if (fd === undefined) {
            bytes = input.subarray(start, end)
        }
        else {
            bytes = new Uint8Array(end - start)
            let offset = 0
            while (offset < bytes.length) {
                const count = readSync(
                    fd, bytes, offset, bytes.length - offset, start + offset
                )
                if (count === 0) {
                    throw new Error(`Unexpected end of file in record ${index}`)
                }
                offset += count
            }
        }
        if (!indexed || bytes[0] !== 40) {
            return bytes
        }
        let at = 1
        let length = ''
        while (bytes[at] >= 48 && bytes[at] <= 57) {
            length += String.fromCharCode(bytes[at++])
        }
        const size = Number(length)
        if (!length || bytes[at++] !== 41 || !Number.isSafeInteger(size) ||
            size <= 0 || at + size > bytes.length) {
            throw new SyntaxError(`Invalid length prefix in record ${index}`)
        }
        const rest = bytes.subarray(at + size)
        if (rest.some(byte => ![9, 10, 13, 32].includes(byte))) {
            throw new SyntaxError(`Trailing bytes in record ${index}`)
        }
        return bytes.subarray(at, at + size)
    }
}

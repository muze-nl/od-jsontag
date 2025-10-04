import JSONTag from '@muze-nl/jsontag';
import Null from '@muze-nl/jsontag/src/lib/Null.mjs'
import serialize from './serialize.mjs'
import {source,isProxy,proxyType,getBuffer,getIndex,isChanged,isParsed,position,parent,resultSet} from './symbols.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function stringToSAB(strData)
{
    const buffer = encoder.encode(strData)
    const sab = new SharedArrayBuffer(buffer.length)
    let uint8sab = new Uint8Array(sab)
    uint8sab.set(buffer,0)
    return uint8sab
}

function SABtoString(arr)
{
    let string = '';
    for (let c of arr) {
        string+= String.fromCharCode(c)
    }
    return string
}

class Slice 
{
    constructor(start, end)
    {
        this.start = start;
        this.end = end;
    }
}

const isSlice = function(r) 
{
    return r instanceof Slice
}

const resetObject = function(ob)
{
    delete ob[Symbol['JSONTag:Type']]
    delete ob[Symbol['JSONTag:Attributes']]
    for (let prop of Object.getOwnPropertyNames(ob)) {
        delete ob[prop]
    }
}

export default class Parser extends JSONTag.Parser
{    

    handlers

    constructor(baseURL, immutable=true)
    {
        super(baseURL)
        this.cachedProxies = new Map() //FIXME: set back to WeakMap
        this.immutable = immutable
        this.handlers = {
            newArrayHandler: {
                get: (target, prop) => {
                    if (target[prop] instanceof Function) {
                        return (...args) => {
                            args = args.map(arg => {
                                if (JSONTag.getType(arg)==='object' && !arg[isProxy]) {
                                    arg = this.getNewValueProxy(arg)
                                }
                                return arg
                            })
                            return target[prop].apply(target, args)
                        }
                    } else if (prop===isChanged) {
                        return true
                    } else {
                        if (this.meta.access && !this.meta.access(target, prop)) {
                            return undefined
                        }
                        if (Array.isArray(target[prop])) {
                            return this.getArrayProxy(target[prop], target, this.handlers.newArrayHandler)
                        }
                        return target[prop]
                    }
                },
                set: (target, prop, value) => {
                    if (prop === isChanged || prop === parent) {
                        // prevent infinite loops, parent is only needed to mark it isChanged
                        // but this is a new array proxy, parent is already dirty
                        return true
                    }
                    if (this.meta.access && !this.meta.access(target, prop)) {
                        return undefined
                    }
                    if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                        value = this.getNewValueProxy(value)
                    } 
                    target[prop] = value
                    return true
                }
            },
            newValueHandler: {
                get: (target, prop) => {
                    switch(prop) {
                        case resultSet:
                            return this.meta.resultArray
                        break;
                        case source:
                            return target
                        break
                        case isProxy:
                            return true
                        break
                        case proxyType:
                            return 'new'
                        break
                        case getBuffer:
                            return (i) => {
                                let index = target[getIndex]
                                if (i != index) {
                                    return encoder.encode('~'+index)
                                }
                                return serialize(target, {meta:this.meta, skipLength:true})
                            }
                        break
                        case getIndex:
                            return target[getIndex]
                        break
                        case isChanged:
                            return true
                        break
                        default:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            if (Array.isArray(target[prop])) {
                                return this.getArrayProxy(target[prop], target, this.handlers.newArrayHandler)
                            }
                            return target[prop]
                        break
                    } 
                },
                set: (target, prop, value) => {
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                        value = this.getNewValueProxy(value)
                    }
                    target[prop] = value
                    return true                    
                }
            },
            arrayHandler: {
                get: (target, prop, receiver) => {
                    const value = target?.[prop]
                    if (value instanceof Function) {
                        // if (['copyWithin','fill','pop','push','reverse','shift','sort','splice','unshift'].indexOf(prop)!==-1) {
                        //     if (immutable) {
                        //         throw new Error('dataspace is immutable')
                        //     }
                        // }
                        return (...args) => {
                            args = args.map(arg => {
                                if (JSONTag.getType(arg)==='object' && !arg[isProxy]) {
                                    arg = this.getNewValueProxy(arg)
                                }
                                return arg
                            })
                            return value.apply(receiver, args)
                        }
                    } else if (prop===isChanged) {
                        return target[isChanged] || target[parent][isChanged]
                    } else if (prop===source) {
                        return target
                    } else {
                        if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                            return undefined
                        }
                        if (Array.isArray(value)) {
                            return this.getArrayProxy(value, target)
                        }
                        return value
                    }
                },
                set: (target, prop, value) => {
                    if (prop == parent) {
                        target[parent] = value
                        return true
                    }
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    if (JSONTag.getType(value)==='object' && !value[isProxy]) {
                        value = this.getNewValueProxy(value)
                    }
                    if (target[prop] === value) {
                        return true
                    } 
                    target[prop] = value
                    target[isChanged] = true
                    target[parent][isChanged] = true
                    return true
                },
                deleteProperty: (target, prop) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'deleteProperty')) {
                        return undefined
                    }
                    //FIXME: if target[prop] was the last reference to an object
                    //that object should be deleted so that its line will become empty
                    //when stringifying resultArray again
                    if (typeof target[prop] === 'undefined') {
                        return true
                    }
                    delete target[prop]
                    target[isChanged] = true
                    target[parent][isChanged] = true
                    return true
                }
            },
            defaultHandler: {
                get: (target, prop, receiver) => {
                    switch(prop) {
                        case resultSet:
                            return this.meta.resultArray
                        break;
                        case isProxy:
                            return true
                        break
                        case proxyType:
                            return 'parse'
                        break
                        case getBuffer:
                            return (i) => {
                                let index = target[getIndex]
                                if (i != index) {
                                    return encoder.encode('~'+index)
                                }
                                if (target[isChanged]) {
                                    return serialize(target, {skipLength: true})
                                }
                                return target[position].input.slice(target[position].start,target[position].end)
                            }
                        break
                        case getIndex:
                            return target[getIndex]
                        break
                        case isChanged:
                            return target[isChanged]
                        break
                    }
                    this.firstParse(target, receiver)
                    switch(prop) {
                        case source:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            return target
                        break
                        default:
                            if (this.meta.access && !this.meta.access(target, prop, 'get')) {
                                return undefined
                            }
                            if (Array.isArray(target[prop])) {
                                return this.getArrayProxy(target[prop], target)
                            }
                            return target[prop]
                        break
                    }
                },
                set: (target, prop, value, receiver) => {
                    if (this.immutable && prop!==resultSet && prop!==source && prop!==isChanged) {
                        throw new Error('dataspace is immutable')
                    }
                    switch(prop) {
                        case isChanged:
                            break
                        case source:
                            resetObject(target)
                            target[position] = value[position]
                            target[isParsed] = false
                            target[isChanged] = false
                            return true
                            break
                        case resultSet:
                            break
                    }
                    this.firstParse(target, receiver)
                    if (this.meta.access && !this.meta.access(target, prop, 'set')) {
                        return undefined
                    }
                    if (value && JSONTag.getType(value)==='object' && !value[isProxy]) {
                        value = this.getNewValueProxy(value)
                    }
                    if (target[prop] === value) {
                        return true
                    }
                    target[prop] = value
                    target[isChanged] = true
                    return true
                },
                deleteProperty: (target, prop) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'deleteProperty')) {
                        return undefined
                    }
                    this.firstParse(target)
                    if (typeof target[prop] === 'undefined') {
                        return true
                    }
                    delete target[prop]
                    target[isChanged] = true
                    return true
                },
                ownKeys: (target) => {
                    this.firstParse(target)
                    return Reflect.ownKeys(target)
                },
                getOwnPropertyDescriptor: (target, prop) => {
                    this.firstParse(target)
                    return Reflect.getOwnPropertyDescriptor(target, prop)
                },
                defineProperty: (target, prop, descriptor) => {
                    if (this.immutable) {
                        throw new Error('dataspace is immutable')
                    }
                    if (this.meta.access && !this.meta.access(target, prop, 'defineProperty')) {
                        return undefined
                    }
                    this.firstParse(target)
                    target[isChanged] = true
                    return Object.defineProperty(target, prop, descriptor)
                },
                has: (target, prop) => {
                    if (this.meta.access && !this.meta.access(target, prop, 'has')) {
                        return false
                    }
                    this.firstParse()
                    return prop in target
                },
                setPrototypeOf: () => {
                    throw new Error('changing prototypes is not supported')
                }
            }
        }
    }

    next(c)
    {
        if (c && c!==this.ch) {
            let source = SABtoString(this.input)
            this.error("Expected '"+c+"' instead of '"+this.ch+"':"+this.at+':'+source)
        }
        this.ch = String.fromCharCode(this.input.at(this.at))
        this.at+=1
        return this.ch
    }

    error(m)
    {
        let context
        try {
            context = decoder.decode(this.input.slice(this.at,this.at+100));
        } catch(e) {

        }
        throw {
            name: 'SyntaxError',
            message: m,
            at: this.at,
            input: context
        }
    }

    array()
    {
        let item, array = []
        if (this.ch !== '[') {
            this.error("Syntax error")
        }
        this.next('[')
        this.whitespace()
        if (this.ch===']') {
            this.next(']')
            return array
        }
        while(this.ch) {
            item = this.value()
            this.checkUnresolved(item, array, array.length)
            if (isSlice(item)) {
                array = array.concat(this.meta.resultArray.slice(item.start, item.end))
            } else {
                array.push(item)
            }
            this.whitespace()
            if (this.ch===']') {
                this.next(']')
                return array
            }
            this.next(',')
            this.whitespace()
        }
        this.error("Input stopped early")
    }


    object(object={})
    {
        let key, val
        if (this.ch !== '{') {
            this.error("Syntax Error")
        }
        this.next('{')
        this.whitespace()
        resetObject(object)
        if (this.ch==='}') {
            this.next('}')
            return object
        }
        let enumerable = true
        while(this.ch) {
            if (this.ch==='#') {
                enumerable = false
                this.next()
            } else {
                enumerable = true
            }
            key = this.string()
            if (key==='__proto__') {
                this.error("Attempt at prototype pollution")
            }
            this.whitespace()
            this.next(':')
            val = this.value()
            if (!enumerable) {
                Object.defineProperty(object, key, {
                    configurable: true, //important, must be true, otherwise Proxies cannot use it
                    writable: true, // handle immutability in the Proxy traps
                    enumerable: false,
                    value: val
                })
            } else {
                object[key] = val
            }
            this.checkUnresolved(val, object, key)
            this.whitespace()
            if (this.ch==='}') {
                this.next('}')
                return object
            }
            this.next(',')
            this.whitespace()
        }
        this.error("Input stopped early")
    }

    string(tagName)
    {
        let value = [], hex, i, uffff;
        if (this.ch !== '"') {
            this.error("Syntax Error")
        }
        this.next('"')
        while(this.ch) {
            if (this.ch==='"') {
                this.next()
                let bytes = new Uint8Array(value)
                value = decoder.decode(bytes)
                this.checkStringType(tagName, value)
                return value
            }
            if (this.ch==='\\') {
                this.next()
                if (this.ch==='u') {
                    for (i=0; i<4; i++) {
                        hex = parseInt(this.next(), 16)
                        if (!this.isFinite(hex)) {
                            break
                        }
                        uffff = uffff * 16 + hex
                    }
                    let str = String.fromCharCode(uffff) 
                    let bytes = encoder.encode(str)
                    value.push.apply(value, bytes)
                    this.next()
                } else if (typeof this.escapee[this.ch] === 'string') {
                    value.push(this.escapee[this.ch].charCodeAt(0))
                    this.next()
                } else {
                    break
                }
            } else {
                value.push(this.ch.charCodeAt(0))
                this.next()
            }
        }
        this.error("Syntax error: incomplete string")
    }

    length()
    {
        this.whitespace()
        this.next('(')
        let numString=''
        while(this.ch>='0' && this.ch<='9') {
            numString += this.ch
            this.next()
        }
        if (this.ch!==')') {
            this.error('Syntax error: not a length')
        }
        this.next()
        return parseInt(numString)
    }

    offset()
    {
        this.next('~')
        let numString = ''
        while(this.ch>='0' && this.ch<='9') {
            numString += this.ch
            this.next()
        }
        if (this.ch=='-') {
            this.next('-')
            let endString = ''
            while(this.ch>='0' && this.ch<='9') {
                endString += this.ch
                this.next()
            }
            return new Slice(parseInt(numString),parseInt(endString)+1) // +1 because array.slice(start,end) slices upto but not including end
        }
        return parseInt(numString)
    }

    parseValue(position, ob={})
    {
        this.input = position.input
        this.at = position.start
        this.next()
        let result = this.value(ob)
        if (result instanceof JSONTag.Link) {
            result = this.handleLink(result)
        }
        return result
    }

    handleLink(link)
    {
        let id = ''+link
        let links = this.meta.unresolved.get(id)
        if (links.length) {
            throw Error('nyi')            
        }
    }

    value = function(ob={})
    {
        let tagOb, result, tagName;
        this.whitespace()
        if (this.ch==='~') {
            let vOffset = this.offset()
            if (isSlice(vOffset)) {
                return vOffset
            }
            return this.meta.resultArray[vOffset]
        }
        if (this.ch==='<') {
            tagOb = this.tag()
            tagName = tagOb.tagName
            this.whitespace()
        }
        switch(this.ch) {
            case '{':
                if (tagName && tagName!=='object') {
                    this.typeError(tagName, this.ch)
                }
                result = this.object(ob)
            break
            case '[':
                if (tagName && tagName!=='array') {
                    this.typeError(tagName, this.ch)
                }
                result = this.array()
            break
            case '"':
                result = this.string(tagName)
            break
            case '-':
                result = this.number(tagName)
            break
            default:
                if (this.ch>='0' && this.ch<='9') {
                    result = this.number(tagName)
                } else {
                    result = this.boolOrNull(tagName)
                }
            break
        }
        if (tagOb) {
            if (result === null) {
                result = new Null()
            }
            if (typeof result !== 'object') {
                switch(typeof result) {
                    case 'string':
                        result = new String(result)
                        break
                    case 'number':
                        result = new Number(result)
                        break
                    default:
                        this.error('Syntax Error: unexpected type '+(typeof result))
                        break
                }
            }
            if (tagOb.tagName) {
                JSONTag.setType(result, tagOb.tagName)
            }
            if (tagOb.attributes) {
                JSONTag.setAttributes(result, tagOb.attributes)
            }
        }
        return result
    }
    
    jump()
    {
        this.next('+')
        return this.number()
    }

    lengthValue(i)
    {
        this.whitespace()
        if (!this.ch) {
            this.next()
        }
        let l, v
        if (this.ch=='+') {
            i += this.jump()
        } else {
            l = this.length()
            v = this.valueProxy(l,i)
        }
        return [l, v, i]
    }

    valueProxy(length, index)
    {
        let cache = {}
        cache[getIndex] = index
        cache[isChanged] = false
        cache[isParsed] = false
        // current offset + length contains jsontag of this value
        cache[position] = {
            input: this.input,
            start: this.at-1,
            end: this.at-1+length
        }
        this.at += length
        this.next()
        // newValueHandler makes sure that value[getBuffer] runs stringify
        // arrayHandler makes sure that changes in the array set targetIsChanged to true
        let result = new Proxy(cache, this.handlers.defaultHandler)
        this.cachedProxies.set(cache, result)
        return result
    }

    makeChildProxies(parent)
    {
        Object.entries(parent).forEach(([key,entry]) => {
            if (Array.isArray(entry)) {
                this.makeChildProxies(entry)
            } else if (entry && JSONTag.getType(entry)==='object') {
                if (entry[isProxy]) {
                    // do nothing
                } else {
                    parent[key] = this.getNewValueProxy(entry)
                }
            }
        })
    }

    getArrayProxy(arr, par, handler)
    {
        if (!handler) {
            handler = this.handlers.arrayHandler
        }
        if (!this.cachedProxies.has(arr)) {
            this.cachedProxies.set(arr, new Proxy(arr, handler))
        }
        let aProxy = this.cachedProxies.get(arr)
        aProxy[parent] = par
        return aProxy
    }

    firstParse(target)
    {
        if (!target[isParsed]) {
            this.parseValue(target[position], target)
            target[isParsed] = true
        }
    }


    getNewValueProxy(value)
    {
        if (value === null) {
            return null
        }
        let index = this.meta.resultArray.length
        this.meta.resultArray.push('')
        value[getIndex] = index
        this.makeChildProxies(value)
        let result = new Proxy(value, this.handlers.newValueHandler)
        this.cachedProxies.set(value, result)
        this.meta.resultArray[index] = result
        return result
    }

    parse(input)
    {
        if (typeof input == 'string' || input instanceof String) {
            input = stringToSAB(input)
        }
        if (!(input instanceof Uint8Array)) {
            this.error('parse only accepts Uint8Array or String as input')
        }
        if (!this.meta.resultArray) {
            this.meta.resultArray = []
        }

        this.ch = ' '
        this.at = 0
        this.input = input

        let line = 0
        while(this.ch && this.at<this.input.length) {
            let result = this.lengthValue(line) // needs to return current line nr
            this.whitespace()
            line = result[2]
            if (result[1]) {
                if (!this.meta.resultArray[line] || this.meta.resultArray[line][proxyType]=='new') {
                    this.meta.resultArray[line] = result[1]
                } else {
                    this.meta.resultArray[line][source] = result[1]
                }
                line++
            }
        }
        return this.meta.resultArray[0]
    }

    checkUnresolved() {
        // TODO:
        // for now assume there are no <link> objects in od-jsontag
        // JSONTag Parser.checkUnresolved triggers firstParse, 
        // while parsing the current object
    }
}
import JSONTag from '@muze-nl/jsontag'
import {source} from './symbols.mjs'

export function getType(obj) {
    return JSONTag.getType(obj?.[source] ?? obj)
}

export function getAttribute(obj, attr) {
    return JSONTag.getAttribute(obj?.[source] ?? obj, attr)
}

export function getAttributes(obj) {
    return JSONTag.getAttributes(obj?.[source] ?? obj)
}

export function getAttributeString(obj) {
    return JSONTag.getAttributesString(obj?.[source] ?? obj)
}

export function getTypeString(obj) {
    return JSONTag.getTypeString(obj?.[source] ?? obj)
}

export function isNull(obj) {
    return JSONTag.isNull(obj?.[source] ?? obj)
}
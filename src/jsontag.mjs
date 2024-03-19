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

export function setAttribute(obj, attr, value) {
    return JSONTag.setAttribute(obj?.[source] ?? obj, attr, value)
}

export function setAttributes(obj, attr) {
    return JSONTag.setAttribute(obj?.[source] ?? obj, attr)
}

export function setType(obj, type) {
    return JSONTag.setType(obj?.[source] ?? obj, type)
}

export function addAttribute(obj, attr, value) {
    return JSONTag.addAttribute(obj?.[source] ?? obj, attr, value)
}

export function removeAttribute(obj, attr) {
    return JSONTag.removeAttribute(obj?.[source] ?? obj, attr)
}


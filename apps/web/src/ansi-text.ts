// oxlint-disable no-control-regex -- this module exists to match ANSI escape sequences.
const oscSequence = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const csiSequence = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const singleEscape = /\u001b[@-Z\\-_]/g
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/**
 * Pi extensions format their UI text for a terminal, so it arrives with ANSI
 * escape sequences. The browser renders them as literal text, so drop them.
 */
export function stripAnsiText(text: string) {
  return text.replace(oscSequence, '').replace(csiSequence, '').replace(singleEscape, '').replace(controlCharacters, '')
}

/** Single-line terminal text (status bar, widget line, notification). */
export function stripAnsiLine(text: string) {
  return stripAnsiText(text).replace(/\s+/g, ' ').trim()
}

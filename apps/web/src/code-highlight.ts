import { createHighlighterCore, createCssVariablesTheme, type ThemedToken } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const languages = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
}
const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', py: 'python', yml: 'yaml', md: 'markdown' }
let highlighter: ReturnType<typeof createHighlighterCore> | undefined

export async function highlightCode(code: string, language: string): Promise<ThemedToken[][] | undefined> {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase()
  if (!Object.hasOwn(languages, name)) return undefined
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), createCssVariablesTheme({ name: 'pi-nest-dark' })],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }).catch((error: unknown) => { highlighter = undefined; throw error })
  const instance = await highlighter
  await instance.loadLanguage(languages[name as keyof typeof languages]())
  return instance.codeToTokens(code, { lang: name, themes: { light: 'github-light', dark: 'pi-nest-dark' } }).tokens
}

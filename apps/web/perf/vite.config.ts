import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config.js'

export default mergeConfig(base, defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  build: { outDir: '../node_modules/.cache/markdown-perf', emptyOutDir: true },
  server: { port: 5187, host: '127.0.0.1' },
  preview: { port: 5187, host: '127.0.0.1' },
}))

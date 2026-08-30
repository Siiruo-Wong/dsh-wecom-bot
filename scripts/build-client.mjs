/**
 * 构建浏览器半侧 bundle(lib/client.js)。
 *
 * 产物形态与 harness 的 clientBundle 预设一致:单个 CJS closure-factory,
 * 调用 window.__ModuleLoader__.load({ id, factory });外部依赖(@deepseek-ai/*
 * 与 react 系列)通过 factory 注入的 require 走模块表,不打包。
 * 无 CSS modules:卡片用内联样式,免去 lightningcss 依赖。
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const ID = pkg.name

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  outfile: 'lib/client.js',
  sourcemap: false,
  // 模块表 specifier:平台模块 + 已加载的 dsh.client 包 + react 系列
  external: ['@deepseek-ai/*', 'react', 'react/*'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '\tid: ' + JSON.stringify(ID) + ',',
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ].join('\n'),
  },
  footer: {
    js: '\n\t}\n});',
  },
})
console.log('lib/client.js built (' + ID + ')')

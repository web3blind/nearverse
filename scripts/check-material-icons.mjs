// Bounded regression check: no SDK execution, wallet, optimizer scan or full build.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from '../src/sdk/material-icons.mjs';
import { ArrowDownwardW700 } from '@material-symbols-svg/react-rounded/icons/arrow-downward';
import { OpenInNewW700 } from '@material-symbols-svg/react-rounded/icons/open-in-new';
assert.deepEqual(Object.keys(icons).sort(),['ArrowDownward','OpenInNew']);
assert.equal(icons.ArrowDownward,ArrowDownwardW700);
assert.equal(icons.OpenInNew,OpenInNewW700);
for(const [name,icon] of Object.entries(icons)) {
 const markup=renderToStaticMarkup(createElement(icon,{'aria-label':name}));
 assert(markup.includes('<svg'));
 assert(markup.includes(`aria-label="${name}"`));
 assert(markup.includes('<path'));
}
const barrel=await readFile(new URL('../node_modules/@material-symbols-svg/react-rounded/dist/w700.js',import.meta.url),'utf8');
for(const [leaf,name] of [['arrow-downward','ArrowDownward'],['open-in-new','OpenInNew']]) {
 assert(barrel.split('\n').some(line=>line.includes(`${name}W700 as ${name},`)&&line.includes(`'./icons/${leaf}.js'`)));
}
const root=new URL('../node_modules/@aurora-is-near/intents-swap-widget/dist/',import.meta.url);
const consumers=new Set();let examined=0;
for(const name of await readdir(root,{recursive:true})) {
 if(!name.endsWith('.js'))continue;
 assert(++examined<1500,'Unexpected SDK expansion: reassess the bounded check');
 const source=await readFile(new URL(name,root),'utf8');
 for(const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@material-symbols-svg\/react-rounded\/w700["']/g)) {
  for(const specifier of match[1].split(','))consumers.add(specifier.trim().split(/\s+as\s+/)[0]);
 }
 assert(!/import\s+(?:\*\s+as|[\w$]+\s+from)[^;]*["']@material-symbols-svg\/react-rounded\/w700["']/.test(source),'Namespace/default barrel import needs reassessment');
}
assert.deepEqual([...consumers].sort(),Object.keys(icons).sort(),'SDK barrel consumers changed; extend exact leaf mapping before use');
// Evaluate only the config factory, not Vite's optimizer or application graph.
// An optional baseline config proves this regression check fails before the fix.
const configUrl = process.argv[2]
  ? pathToFileURL(process.argv[2])
  : new URL('../vite.config.ts', import.meta.url);
const compiled = ts.transpileModule(await readFile(configUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
// Plugin constructors are irrelevant to alias selection. Keep them inert so this
// check cannot initialize a compiler, optimizer service or SDK dependency graph.
const inertModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const configImports = {
  'vitest/config': inertModule('export const defineConfig = value => value;'),
  '@vitejs/plugin-react': inertModule('export default () => ({name:"inert-react"});'),
  'vite-plugin-node-polyfills': inertModule('export const nodePolyfills = () => ({name:"inert-polyfills"});'),
  'node:url': 'node:url',
};
const executable = compiled
  .replace(/from\s*(['"])([^'"]+)\1/g, (_, quote, specifier) => {
    assert(Object.hasOwn(configImports, specifier), `New config import needs bounded-check review: ${specifier}`);
    return `from ${JSON.stringify(configImports[specifier])}`;
  })
  .replace(/\bimport\.meta\.url\b/g, JSON.stringify(new URL('../vite.config.ts', import.meta.url).href));
const { default: makeConfig } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
for (const mode of ['development', 'production', 'test']) {
  const config = makeConfig({ mode, command: 'build' });
  const aliases = config.resolve?.alias ?? [];
  const aliasFor = value => aliases.find(item => item.find instanceof RegExp ? item.find.test(value) : item.find === value);
  assert.equal(aliasFor('@material-symbols-svg/react-rounded/w700')?.replacement,
    fileURLToPath(new URL('../src/sdk/material-icons.mjs', import.meta.url)), `${mode}: icon barrel must resolve to the two-leaf adapter`);
  for (const untouched of ['@material-symbols-svg/react-rounded/w400', '@material-symbols-svg/react-rounded/w700-extra', '@material-symbols-svg/react-rounded/icons/open-in-new', '@aurora-is-near/intents-swap-widget-standalone']) {
    assert.equal(aliasFor(untouched), undefined, `${mode}: unrelated import must remain unchanged`);
  }
}
console.log(JSON.stringify({checks:'identity, original W700 exports, accessible SVG markup, SDK consumer contract, actual config alias in all modes',examined,consumers:[...consumers].sort(),rssBytes:process.memoryUsage().rss}));

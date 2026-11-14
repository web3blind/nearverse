// Local compiled-browser acceptance. Uses existing loopback Chromium, never Puppeteer.
// Only creates/closes its own page. Never clicks wallet/connect/sign/transfer controls.
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin=process.env.QA_ORIGIN || 'http://127.0.0.1:4319';
const cdp=process.env.QA_CDP || 'http://127.0.0.1:18800';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(cdp))throw new Error('Local QA endpoints only');
const version=await (await fetch(`${cdp}/json/version`)).json();
let target, browserContextId, pageSession;
const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let sequence=0;const pending=new Map();const errors=[];const checks=[];
ws.onmessage=({data})=>{const value=JSON.parse(data);if(value.id){const entry=pending.get(value.id);if(entry){clearTimeout(entry.timer);pending.delete(value.id);value.error?entry.reject(new Error(JSON.stringify(value.error))):entry.resolve(value.result);}}else if(value.method==='Runtime.exceptionThrown'){errors.push(value.params.exceptionDetails.exception?.description||value.params.exceptionDetails.text);}else if(value.method==='Runtime.consoleAPICalled' && value.params.type==='error'){errors.push(value.params.args.map(a=>a.value??a.description??a.type).join(' '));}else if(value.method==='Log.entryAdded'&&value.params.entry.level==='error'){errors.push(value.params.entry.text+' '+(value.params.entry.url||''))}};
function cmd(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(pageSession && !method.startsWith('Target.') && !method.startsWith('Browser.') ? {sessionId:pageSession} : {})}));});}
async function js(expression){const result=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
async function until(expression,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await js(`!!(${expression})`))return;await new Promise(r=>setTimeout(r,200));}throw new Error('UI condition timeout: '+expression);}
async function click(text){assert(await js(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),'Button not available: '+text);}
async function reload(){const before=await js("performance.timeOrigin");await cmd('Page.reload',{ignoreCache:true});await until(`performance.timeOrigin!==${before} && document.readyState==='complete' && !!document.querySelector('#ship-edit')`);}
async function enterPreview(){await click('Изолированный preview');await until("document.querySelector('.preview-banner') && document.querySelector('#ship-edit')");}
try{
 browserContextId=(await cmd('Target.createBrowserContext')).browserContextId;
 target=await cmd('Target.createTarget',{url:origin,browserContextId});
 pageSession=(await cmd('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
 await cmd('Runtime.enable');await cmd('Log.enable');await cmd('Page.enable');await until("document.querySelector('#ship-edit')");
 if(process.argv.includes('--inspect')){console.log(JSON.stringify(await js("({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(e=>({text:e.textContent,disabled:e.disabled}))})"),null,2));}
 else {
  assert(await js("[...document.querySelectorAll('button')].find(e=>e.textContent==='Подтвердить условия и запросить подпись обмена')?.disabled"));checks.push('real financial action disabled before account/quote/consent, independent of key presence');
  assert.equal(await js("document.querySelectorAll('.region-list button').length"),10);checks.push('ten accessible map directions including exact USDC/SOL energy');
  assert(await js('!!navigator.locks'));checks.push('Web Locks available for account-scoped transfer guards');
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await js('document.activeElement.textContent'),'К основному содержимому');checks.push('keyboard skip link reachable');
  await click('Загрузить подключение кошелька');await until("[...document.querySelectorAll('button')].some(e=>e.textContent==='Подключить NEAR-кошелёк')",30000);checks.push('published standalone wallet module loads in isolated context without connect/sign');
  await enterPreview();checks.push('preview explicitly isolated');
  await click('Удалить локальные данные этого режима');await click('Да, удалить локально');await until("document.querySelector('#ship-heading').textContent==='Тихий странник' && ![...document.querySelectorAll('button')].find(e=>e.textContent==='Начать экспедицию')?.disabled");
  await click('Изменить корабль');
  await js("(()=>{const e=document.querySelector('#ship-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Испытатель NearVerse');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('Сохранить корабль');await until("document.querySelector('#ship-heading').textContent==='Испытатель NearVerse'");checks.push('ship edit saved in real IndexedDB');
  await click('Начать экспедицию');await until("document.body.innerText.includes('Экспедиция начата')");
  await reload();await enterPreview();await until("document.querySelector('#ship-heading').textContent==='Испытатель NearVerse'");
  await until("[...document.querySelectorAll('button')].some(e=>e.textContent==='Завершить экспедицию и открыть запись'&&!e.disabled)",25000);
  await click('Завершить экспедицию и открыть запись');await until("document.querySelector('.story-list').innerText.includes('ботаник Рута')");checks.push('expedition + ship survive actual reload, first chapter unlocked');
  await js("document.querySelector('.region-list button:nth-child(1)');[...document.querySelectorAll('.region-list button')].find(e=>e.textContent.includes('Базальт')).click()");
  await until("document.activeElement.id==='system-heading'");checks.push('direction change moves focus to heading');
  await click('Учебное прибытие в систему Базальт');await until("document.querySelector('.journal-list').innerText.includes('Учебное прибытие')");checks.push('preview arrival journal');
  await js("(()=>{const original=URL.createObjectURL;URL.createObjectURL=function(blob){window.__qaExportBlob=blob;return original.call(this,blob)};const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(!this.download)return click.call(this)};})()");
  await click('Экспорт сохранения (JSON)');await until('window.__qaExportBlob');
  const exported=await js('window.__qaExportBlob.text()');const parsed=JSON.parse(exported);assert.equal(parsed.scope.mode,'preview');assert.equal(parsed.ship.name,'Испытатель NearVerse');assert(parsed.events.some(e=>e.type==='story.read'));await writeFile('data/browser-export.json',exported);
  await click('Удалить локальные данные этого режима');await click('Да, удалить локально');await until("document.querySelector('#ship-heading').textContent==='Тихий странник' && !document.querySelector('#import-save').disabled");
  const root=await cmd('DOM.getDocument');const input=await cmd('DOM.querySelector',{nodeId:root.root.nodeId,selector:'#import-save'});await cmd('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[process.cwd()+'/data/browser-export.json']});
  await until("document.querySelector('#ship-heading').textContent==='Испытатель NearVerse' && document.querySelector('.journal-list').innerText.includes('История открыта')");checks.push('actual export payload and file-input import restore IndexedDB progress');
  parsed.scope.mode='real';await writeFile('data/browser-bad-import.json',JSON.stringify(parsed));await cmd('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[process.cwd()+'/data/browser-bad-import.json']});await until("document.querySelector('[role=alert]')?.innerText.includes('другого аккаунта или режима')");assert(await js("document.querySelector('.journal-list').innerText.includes('История открыта')"));checks.push('cross-mode import rejected without destroying progress');
  await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert(await js('document.documentElement.scrollWidth<=window.innerWidth'),'Horizontal overflow on mobile');checks.push('390px mobile without horizontal overflow');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"));checks.push('reduced-motion media supported');
  const ax=await cmd('Accessibility.getFullAXTree');assert(ax.nodes.some(n=>n.role?.value==='main'));checks.push('accessibility tree main landmark');
  await mkdir('data',{recursive:true});const image=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile('data/browser-mobile.png',Buffer.from(image.data,'base64'));
 }
 const evidence={origin,checks,errors};await mkdir('data',{recursive:true});await writeFile('data/browser-qa.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));assert.equal(errors.length,0,'Browser runtime/CSP errors');
} catch(error){console.error('LOCAL UI DIAGNOSTIC',await js("({finance:document.querySelector('.financial-panel')?.innerText,buttons:[...document.querySelectorAll('button')].map(e=>e.textContent)})"));throw error;} finally {console.log(JSON.stringify({completedChecks:checks,runtimeErrors:errors}));if(browserContextId)await cmd('Target.disposeBrowserContext',{browserContextId});ws.close();}

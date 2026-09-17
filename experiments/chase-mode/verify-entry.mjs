import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CHASE_PLAYWRIGHT || 'playwright');
const root = new URL('../../', import.meta.url);
const out = new URL(process.env.CHASE_ENTRY_OUT || 'tmp/entry-verification/', root);
await mkdir(new URL('cache/',out),{recursive:true});
const base = process.env.CHASE_URL || 'http://127.0.0.1:8000/prototype/';
const source = await readFile(new URL('prototype/main.js',root),'utf8');
const hook = `window.entryTest={stop:()=>renderer.setAnimationLoop(null),snap:()=>({chaseMode,setupMode,devMode,started,car:playerCar?.info(),url:shareUrl(),paused:chasePaused,overview:chaseOverview}),drive:()=>stepChaseFlight(1),start:()=>startFlight(-1267,2719)};`;
const browser=await chromium.launch({headless:true});
const results=[];
async function make(mobile=false){
 const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1280,height:900}});
 await context.route('https://**/*',async route=>{
  const url=route.request().url();
  if(url.includes('open-meteo.com')) return route.abort();
  const filename=createHash('sha256').update(url).digest('hex')+'.json';
  const file=new URL('cache/'+filename,out);
  const caches=[file];
  if(process.env.CHASE_CACHE) caches.unshift(new URL(filename,new URL('file:///'+process.env.CHASE_CACHE.replaceAll('\\','/')+'/')));
  for(const cachedFile of caches)try{const c=JSON.parse(await readFile(cachedFile,'utf8'));return route.fulfill({status:c.status,headers:c.headers,body:Buffer.from(c.body,'base64')})}catch{}
  try{const response=await route.fetch({timeout:20000});const body=await response.body();
   if(response.ok())await writeFile(file,JSON.stringify({status:response.status(),headers:response.headers(),body:body.toString('base64')}));
   await route.fulfill({response,body});
  }catch{await route.abort().catch(()=>{})}
 });
 await context.route('**/prototype/main.js',route=>route.fulfill({contentType:'text/javascript',body:source+hook}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 return {context,page,errors};
}
async function done(t,name){assert.deepEqual(t.errors,[],name);results.push(name);console.log('PASS',name);await t.context.close()}
try{
 for(const mobile of [false,true]){
  const t=await make(mobile);await t.page.goto(new URL('../',base).href);
  await t.page.locator('#hero-title').waitFor();
  assert.match(await t.page.title(),/GameTarget/);
  assert.equal(await t.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const sora=t.page.locator('[data-sora-link]').first();await sora.waitFor();
  assert.equal(await sora.getAttribute('href'),'http://localhost:8002/');
  await t.page.screenshot({path:fileURLToPath(new URL(mobile?'home-mobile.png':'home-desktop.png',out)),fullPage:true});
  await done(t,mobile?'home-mobile':'home-desktop');
 }
 for(const query of ['', '?setup=1','?a=130.25,33.27','?dev=1','?mode=chase']){
  const t=await make();await t.page.goto(base+query,{waitUntil:'domcontentloaded'});
  if(query==='?setup=1'||query==='?dev=1'){
   await t.page.locator('#area-presets button').first().click();await t.page.locator('#area-btn').click();
  }
  await t.page.waitForFunction(()=>!!window.entryTest,null,{timeout:90000});
  await t.page.evaluate(()=>entryTest.stop());
  if(query && query!=='?mode=chase'){
   assert.equal(await t.page.locator('#dev-briefing').isVisible(),false);
   await t.page.locator('#launch-map').click({position:{x:180,y:180}});
   assert.match(await t.page.locator('#launch-btn').textContent(),/回収レースを開始/);
   await t.page.locator('#launch-btn').click();
  }
  const snap=await t.page.evaluate(()=>entryTest.snap());assert.ok(snap.chaseMode&&snap.started&&snap.car);
  assert.ok(snap.url.includes('mode=chase'));assert.equal(snap.devMode,false);
  assert.equal(await t.page.locator('#tc-burner').isVisible(),false);
  await t.page.keyboard.down('w');await t.page.evaluate(()=>entryTest.drive());await t.page.keyboard.up('w');
  const car=await t.page.evaluate(()=>entryTest.snap().car);assert.ok(Math.hypot(car.x-snap.car.x,car.z-snap.car.z)>0.1);
  await t.page.locator('#chase-pause-btn').click();assert.ok((await t.page.evaluate(()=>entryTest.snap())).paused);
  await t.page.locator('#chase-overview-btn').click();assert.ok((await t.page.evaluate(()=>entryTest.snap())).overview);
  await t.page.locator('#howto-link').click();assert.match(await t.page.locator('#howto-overlay').textContent(),/着地の瞬間/);
  await t.page.locator('#howto-close').click();await t.page.locator('#setup-link').click();
  assert.equal(await t.page.locator('#setup-dev').isVisible(),false);
  assert.equal(await t.page.locator('#setup-road1').isVisible(),false);
  assert.equal(await t.page.locator('#setup-city1').isVisible(),true);
  if(query===''){
   await t.page.screenshot({path:fileURLToPath(new URL('race-settings.png',out))});
   await t.page.locator('#setup-try').click();await t.page.waitForURL(/setup=1/);
   assert.ok(new URL(t.page.url()).searchParams.get('mode')==='chase');
   await t.page.locator('#area-presets').waitFor();
  }
  await done(t,'entry '+(query||'default'));
 }
 const t=await make(true);await t.page.goto(base);await t.page.waitForFunction(()=>!!window.entryTest,null,{timeout:90000});
 await t.page.evaluate(()=>entryTest.stop());
 const snap=await t.page.evaluate(()=>entryTest.snap());
 const btn=t.page.locator('[data-car-key="forward"]');await btn.dispatchEvent('pointerdown');await t.page.evaluate(()=>entryTest.drive());await btn.dispatchEvent('pointerup');
 const car=await t.page.evaluate(()=>entryTest.snap().car);assert.ok(Math.hypot(car.x-snap.car.x,car.z-snap.car.z)>.1);
 await t.page.screenshot({path:fileURLToPath(new URL('race-mobile.png',out))});
 await t.page.locator('#howto-link').click();await t.page.locator('#howto-close').click();
 await done(t,'touch-driving');
 const g=await make();await g.page.goto(new URL('../balloon-guide.html',base).href);
 assert.match(await g.page.locator('main').textContent(),/気球操縦の読みもの/);
 assert.equal(await g.page.locator('a[href^="./prototype/"]').count(),0);await done(g,'preserved-guide');
 const linkScript=await readFile(new URL('sora-link.js',root),'utf8');
 for(const [hostname,protocol,expected]of [['localhost','http:','http://localhost:8002/prototype/'],['rhitomigm-hash.github.io','https:','https://rhitomigm-hash.github.io/SORA/prototype/'],['','file:','http://localhost:8002/prototype/']]){
  const link={dataset:{soraQuery:'?setup=1'},href:''};vm.runInNewContext(linkScript,{URL,location:{hostname,protocol},document:{querySelectorAll:()=>[link]}});assert.equal(link.href,expected+'?setup=1');
 }
 results.push('local/public/file SORA links');console.log('PASS SORA link environments');
}finally{await writeFile(new URL('results.json',out),JSON.stringify(results,null,2));await browser.close()}

import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CHASE_PLAYWRIGHT||'playwright');
const root=new URL('../../',import.meta.url);
const out=new URL('tmp/target-map-verification/',root);
await mkdir(out,{recursive:true});
const source=await readFile(new URL('prototype/main.js',root),'utf8');
const hook=`window.targetTest={snap:()=>({paused:chasePaused,open:targetMapOpen,time:remaining,car:playerCar.info(),launch:{...launchSel},keys:[...carKeys],target:{...TARGET_XZ}}),move:()=>playerCar.setPosition(1200,800),pause:()=>toggleChasePause(),stop:()=>renderer.setAnimationLoop(null)};`;
const browser=await chromium.launch({headless:true});
try{
for(const mode of ['desktop','mobile','failed-map']){
 const context=await browser.newContext(mode==='mobile'?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1280,height:800}});
 await context.route('https://**/*',async route=>{
  const url=route.request().url();
  if(mode==='failed-map'&&url.includes('/xyz/std/'))return route.abort();
  const cache=new URL('tmp/entry-verification/cache/'+createHash('sha256').update(url).digest('hex')+'.json',root);
  try{const c=JSON.parse(await readFile(cache,'utf8'));return route.fulfill({status:c.status,headers:c.headers,body:Buffer.from(c.body,'base64')});}catch{}
  if(!url.includes('/xyz/std/'))return route.abort();
  try{const response=await route.fetch({timeout:10000});const body=await response.body();if(response.ok())await writeFile(cache,JSON.stringify({status:response.status(),headers:response.headers(),body:body.toString('base64')}));return route.fulfill({response,body});}catch{return route.abort();}
 });
 await context.route('**/prototype/main.js',r=>r.fulfill({contentType:'text/javascript; charset=utf-8',body:source+hook}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message)});
 await page.goto((process.env.CHASE_URL||'http://127.0.0.1:8000/prototype/'),{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.targetTest,null,{timeout:60000});
 await page.keyboard.down('w');await page.locator('#target-map-btn').click();await page.keyboard.up('w');
 const before=await page.evaluate(()=>targetTest.snap());assert(before.open&&before.paused);assert.equal(before.keys.length,0);
 await page.waitForTimeout(250);
 const after=await page.evaluate(()=>targetTest.snap());assert.deepEqual(after,before);
 const distance=Math.hypot(before.car.x-before.target.x,before.car.z-before.target.z);
 const label=await page.locator('#target-map-distance').textContent();assert.match(label,/ターゲットまで直線/);assert(label.includes(distance>=1000?(distance/1000).toFixed(2):String(Math.round(distance))));
 await page.locator('#target-map-canvas').click({position:{x:70,y:80}});
 assert.deepEqual((await page.evaluate(()=>targetTest.snap())).launch,before.launch);
 await page.locator('#target-map-zoom-in').click();await page.locator('#target-map-zoom-out').click();await page.locator('#target-map-fit').click();
 if(mode==='failed-map')await page.waitForFunction(()=>document.getElementById('target-map-status').textContent.includes('読み込めません'));
 else await page.waitForFunction(()=>!document.getElementById('target-map-status').textContent.includes('読み込み中'),null,{timeout:20000});
 await page.screenshot({path:fileURLToPath(new URL(mode+'.png',out))});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.keyboard.press('Escape');assert.equal((await page.evaluate(()=>targetTest.snap())).paused,false);
 await page.evaluate(()=>{targetTest.pause();targetTest.move()});await page.keyboard.press('t');
 assert((await page.evaluate(()=>targetTest.snap())).open);assert.match(await page.locator('#target-map-distance').textContent(),/1.44km/);
 await page.locator('#target-map-close').click();assert((await page.evaluate(()=>targetTest.snap())).paused);
 if(mode==='mobile'){
  await page.setViewportSize({width:844,height:390});await page.locator('#target-map-btn').click();
  await page.locator('#target-map-close').scrollIntoViewIfNeeded();const closeBox=await page.locator('#target-map-close').boundingBox();assert(closeBox.y>=0&&closeBox.y+closeBox.height<=390);
  await page.screenshot({path:fileURLToPath(new URL('mobile-landscape.png',out))});await page.locator('#target-map-close').click();
 }
 assert.deepEqual(errors,[]);console.log('PASS target map '+mode);await context.close();
}
}finally{await browser.close()}

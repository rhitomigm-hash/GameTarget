import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CHASE_PLAYWRIGHT || 'playwright');
const root = new URL('../../', import.meta.url), out = new URL('tmp/wind-report-verification/', root);
await mkdir(out, { recursive: true });
const source = await readFile(new URL('prototype/main.js', root), 'utf8');
const hook = `
window.windTest = {
  position(distance=200, facing=true) {
    renderer.setAnimationLoop(null); chaseFinished=false; expired=false; remaining=100;
    targetMapOpen=false; document.getElementById('target-map-overlay').style.display='none';
    playerCar.setPosition(0,distance,0);
    camera.clearViewOffset(); camera.updateProjectionMatrix();
    camera.position.set(0,target.position.y+80,distance+40);
    camera.lookAt(facing ? target.position : new THREE.Vector3(0,target.position.y+80,distance+1000));
    updateGroundWindReport(true); renderer.render(scene,camera);
    return this.snap();
  },
  natural() { this.position(200);updateChaseCamera(1/60);updateGroundWindReport(true);renderer.render(scene,camera);return this.snap(); },
  snap() { return { ...groundWindConditions(), reported:chaseWindReported,
    points:chasePoints(false,0,false,chaseWindReported), car:playerCar.info(),
    disabled:document.getElementById('ground-wind-send').disabled }; },
  send() { sendGroundWindReport(); return this.snap(); },
  view() { return {overview:chaseOverview, offset:!!camera.view?.enabled,
    labels:!document.getElementById('chase-overview-labels').hidden,
    pressed:document.getElementById('chase-overview-btn').getAttribute('aria-pressed'),
    nearCar:camera.position.distanceTo(playerCar.group.position)<30}; },
  pauseForView() {chasePaused=true;},
  move() { playerCar.update(.01,{throttle:1,steer:0}); updateGroundWindReport(true); return this.snap(); },
  expire() {expired=true;updateGroundWindReport(true);return this.send();},
  map() {targetMapOpen=true;updateGroundWindReport(true);return this.send();},
  finish() {finishChase(null,'終了テスト');return document.getElementById('result-sub').textContent;},
  visibilityTests() {
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1,.1,1000);
    const target=new THREE.Group();scene.add(target);camera.position.set(0,30,100);camera.lookAt(0,0,0);
    const check=(screenVisible=()=>true)=>isTargetVisible({camera,target,scene,width:800,height:800,screenVisible});
    const clear=check(),covered=check(()=>false);
    const wall=new THREE.Mesh(new THREE.BoxGeometry(100,100,10),new THREE.MeshBasicMaterial());wall.position.set(0,20,50);scene.add(wall);
    const blocked=check();wall.visible=false;const hiddenWall=check();
    camera.lookAt(0,30,300);const behind=check();
    return {clear,covered,blocked,hiddenWall,behind};
  },
  rules() {return [99.999,100,100.001].map(distance=>groundWindReportStatus({active:true,distance,speedMps:0,targetVisible:true}));},
  newGame() {started=false;startFlight(0,1200);renderer.setAnimationLoop(null);return chaseWindReported;}
};`;
const browser = await chromium.launch({headless:true});
try {
  for (const mobile of [false,true]) {
    const context = await browser.newContext(mobile ? {viewport:{width:390,height:844},isMobile:true,hasTouch:true} : {viewport:{width:1280,height:800}});
    await context.route('https://**/*',async route=>{
      const url=route.request().url();
      const cache=new URL('tmp/entry-verification/cache/'+createHash('sha256').update(url).digest('hex')+'.json',root);
      try {const c=JSON.parse(await readFile(cache,'utf8'));return route.fulfill({status:c.status,headers:c.headers,body:Buffer.from(c.body,'base64')});}catch{}
      return route.abort();
    });
    await context.route('**/prototype/main.js',route=>route.fulfill({contentType:'text/javascript; charset=utf-8',body:source+hook}));
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
    await page.goto(process.env.CHASE_URL||'http://127.0.0.1:8000/prototype/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.windTest,null,{timeout:60000});
    assert.deepEqual(await page.evaluate(()=>windTest.rules()),['too-close','ready','ready']);
    assert.deepEqual(await page.evaluate(()=>windTest.visibilityTests()),{clear:true,covered:false,blocked:false,hiddenWall:true,behind:false});
    assert.equal((await page.evaluate(()=>windTest.natural())).status,'ready');
    await page.screenshot({path:fileURLToPath(new URL(mobile?'driving-mobile.png':'driving-desktop.png',out))});
    let snap=await page.evaluate(()=>windTest.position(99.99));assert.equal(snap.status,'too-close');assert(snap.disabled);
    assert.match(await page.locator('#ground-wind-status').textContent(),/100m以上/);
    assert.equal((await page.evaluate(()=>windTest.send())).reported,false);
    await page.screenshot({path:fileURLToPath(new URL(mobile?'warning-mobile.png':'warning-desktop.png',out))});
    snap=await page.evaluate(()=>windTest.position(200,false));assert.equal(snap.status,'not-visible');
    snap=await page.evaluate(()=>{windTest.position(200);return windTest.move()});assert.equal(snap.car.speedKmh,0);assert.equal(snap.status,'moving');
    assert.equal((await page.evaluate(()=>windTest.send())).reported,false);
    snap=await page.evaluate(()=>windTest.position(100));assert.equal(snap.status,'ready');
    snap=await page.evaluate(()=>windTest.map());assert.equal(snap.status,'not-visible');assert.equal(snap.reported,false);
    snap=await page.evaluate(()=>windTest.position(200));assert.equal(snap.status,'ready');assert.equal(snap.disabled,false);
    await page.screenshot({path:fileURLToPath(new URL(mobile?'ready-mobile.png':'ready-desktop.png',out))});
    await page.locator('#ground-wind-send').click();
    snap=await page.evaluate(()=>windTest.snap());assert(snap.reported);assert.equal(snap.points.windReport,50);assert.equal(snap.points.total,50);
    assert.match(await page.locator('#road-radio').textContent(),/黄色車.*ターゲット付近の地上風/);
    assert.match(await page.locator('#road-radio').textContent(),/気球：地上風、了解/);
    assert(await page.locator('#road-radio').isHidden());
    assert(await page.locator('#ground-wind-report').isHidden());
    assert(await page.locator('#wind-report-confirmation').isVisible());
    const sentMessage=await page.locator('#road-radio').textContent();
    snap=await page.evaluate(()=>windTest.send());assert.equal(snap.points.total,50);
    assert.equal(await page.locator('#road-radio').textContent(),sentMessage);
    assert(await page.locator('#road-radio').isHidden());
    // 描画ループを止めた状態でも無線送信後の視点とボタンを同時に切り替える。
    await page.locator('#chase-overview-btn').click();
    assert.deepEqual(await page.evaluate(()=>windTest.view()),{overview:true,offset:true,labels:true,pressed:'true',nearCar:false});
    await page.keyboard.press('o');
    assert.deepEqual(await page.evaluate(()=>windTest.view()),{overview:false,offset:false,labels:false,pressed:'false',nearCar:true});
    await page.evaluate(()=>windTest.pauseForView());
    await page.keyboard.press('o');
    assert((await page.evaluate(()=>windTest.view())).offset);
    await page.keyboard.press('v');
    assert.deepEqual(await page.evaluate(()=>windTest.view()),{overview:false,offset:false,labels:false,pressed:'false',nearCar:true});
    await page.keyboard.press('o');await page.locator('#chase-overview-btn').click();
    assert.equal((await page.evaluate(()=>windTest.view())).overview,false);
    await page.evaluate(()=>windTest.position(99));
    assert(await page.locator('#ground-wind-report').isVisible());
    assert(await page.locator('#ground-wind-send').isHidden());
    assert.match(await page.locator('#ground-wind-status').textContent(),/100m以上/);
    await page.screenshot({path:fileURLToPath(new URL(mobile?'sent-mobile.png':'sent-desktop.png',out))});
    snap=await page.evaluate(()=>windTest.expire());assert.equal(snap.status,'inactive');assert.equal(snap.points.total,50);
    assert.match(await page.evaluate(()=>windTest.finish()),/地上風報告 50点/);
    assert.equal(await page.evaluate(()=>windTest.newGame()),false);
    assert.deepEqual(errors,[]);console.log('PASS ground wind report '+(mobile?'mobile':'desktop'));
    await context.close();
  }
} finally {await browser.close();}

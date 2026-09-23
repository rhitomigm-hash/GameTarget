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
  viewSnap(){return {pos:camera.position.toArray(),q:camera.quaternion.toArray(),fov:camera.fov,active:stoppedCamera.active};},
  refresh(){updateChaseCamera(0);renderer.render(scene,camera);},
  driveCheck() {
    const before=playerCar.info();carKeys.add('KeyW');stepChaseFlight(.5);carKeys.clear();
    const after=playerCar.info();return {distance:Math.hypot(after.x-before.x,after.z-before.z),speed:after.speedMps,observing:false};
  },
  placeCar(distance) {renderer.setAnimationLoop(null);playerCar.setPosition(0,distance,0);},
  markerSetup() {renderer.setAnimationLoop(null);state.grounded=false;expired=false;state.pos.set(0,terrain.getHeight(0,0)+100,0);playerCar.setPosition(0,800,0);dropMarker();announceBalloon("マーカーを投下しました");},
  markerSnap() {return {overview:chaseOverview,camera:camera.position.toArray(),trail:markerTrailPoints.length,trailVisible:markerTrail.visible,landed:marker.state.landed,screen:marker.state.pos.clone().project(camera).toArray()};},
  land() {for(let i=0;i<2400&&!marker.state.landed;i++)stepMarker(1/60);updateChaseCamera(0);renderer.render(scene,camera);},
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
    await page.evaluate(()=>{windTest.placeCar(200);windTest.refresh();});
    const drag=async()=>{await page.mouse.move(mobile?180:640,280);await page.mouse.down();await page.mouse.move(mobile?240:740,320,{steps:5});await page.mouse.up();};
    assert(await page.locator('#stopped-camera-hint').isVisible());
    await page.waitForTimeout(5100);await page.evaluate(()=>windTest.refresh());
    assert(await page.locator('#stopped-camera-hint').isHidden());
    for(let view=0;view<2;view++) {
      const base=await page.evaluate(()=>windTest.viewSnap());
      await drag();const turned=await page.evaluate(()=>windTest.viewSnap());
      assert.deepEqual(turned.pos,base.pos);assert.notDeepEqual(turned.q,base.q);assert(turned.active);
      await page.mouse.wheel(0,-100);await page.waitForTimeout(150);
      const zoomed=await page.evaluate(()=>windTest.viewSnap());assert.deepEqual(zoomed.pos,base.pos);assert(zoomed.fov<base.fov);
      if(mobile){
        const cdp=await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:140,y:280,id:1},{x:240,y:280,id:2}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:160,y:280,id:1},{x:220,y:280,id:2}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        const pinch=await page.evaluate(()=>windTest.viewSnap());assert.deepEqual(pinch.pos,base.pos);assert.notEqual(pinch.fov,zoomed.fov);
      }
      await page.keyboard.press('v');
      const reset=await page.evaluate(()=>windTest.viewSnap());assert(!reset.active);assert.equal(reset.fov,base.fov);
      assert(await page.locator('#stopped-camera-hint').isHidden());
    }
    await drag();await page.evaluate(()=>{windTest.driveCheck();windTest.refresh();});
    assert(!(await page.evaluate(()=>windTest.viewSnap())).active);
    await page.evaluate(()=>{windTest.placeCar(200);windTest.refresh();});assert(await page.locator('#stopped-camera-hint').isVisible());
    await page.keyboard.press('o');assert((await page.evaluate(()=>windTest.driveCheck())).distance>0);await page.keyboard.press('o');
    await page.evaluate(()=>windTest.markerSetup());assert.equal(await page.locator('#marker-follow-btn').count(),0);
    await page.evaluate(()=>windTest.land());
    const snap=await page.evaluate(()=>windTest.markerSnap());assert(snap.landed);assert.equal(snap.trail,0);assert.equal(snap.trailVisible,false);
    assert.match(await page.locator('#road-radio').textContent(),/着地/);
    await page.keyboard.press('o');
    assert(await page.locator('.chase-map-marker').isVisible());
    await page.screenshot({path:fileURLToPath(new URL(mobile?'marker-mobile.png':'marker-desktop.png',out))});
    await page.keyboard.press('o');
    assert.deepEqual(errors,[]);console.log('PASS marker observation '+(mobile?'mobile':'desktop'));
    await context.close();
  }
} finally {await browser.close();}

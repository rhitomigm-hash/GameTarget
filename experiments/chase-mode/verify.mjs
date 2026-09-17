// 実データを読むブラウザで、実装そのものを検証する。
// 先にリポジトリを http://127.0.0.1:8000 で配信する。
// CHASE_PLAYWRIGHT に Playwright パッケージの絶対パスを指定できる。
// テスト用アクセス口はレスポンスにだけ追加し、本体には保存しない。
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CHASE_PLAYWRIGHT || 'playwright');
const root = new URL('../../', import.meta.url);
const source = await readFile(new URL('prototype/main.js', root), 'utf8');
const output = new URL(process.env.CHASE_VERIFY_OUT || 'tmp/chase-verification/', root);
await mkdir(output, { recursive: true });
const hook = `
window.chaseTest = {
  stop: () => renderer.setAnimationLoop(null),
  snap: () => ({started, chaseMode, chaseFinished, grounded: state.grounded,
    pos: {...state.pos}, fuel: state.fuel, car: playerCar?.info(),
    dropped: !!marker.state, landed: !!marker.state?.landed, remaining,
    keys: [...carKeys], look: chaseLookBalloon, overview: chaseOverview, timeScale, url: shareUrl(),
    autoCars: !!(chaseCar || chaseCar2), controls: controls.enabled,
    crew: [chaseCar?.info(),chaseCar2?.info()], roadMeters:chaseRoadMeters, paused:chasePaused}),
  roadReady: () => !!(roadReady && chaseCar && chaseCar2 && !chaseCrewLoading),
  live: () => renderer.setAnimationLoop(loopForTest),
  roadTrial: () => {
    const b = chaseBounds;
    for (const edge of roadReady.graph.edges.values()) {
      if (edge.props.motorway===1 || edge.props.rdCtg===3 || edge.props.tollSect===1) continue;
      const w=edge.world;
      for(let i=2;i<w.length;i+=2) {
        const dx=w[i]-w[i-2], dz=w[i+1]-w[i-1], len=Math.hypot(dx,dz);
        if(len<100 || w[i-2]<b.minX+200 || w[i-2]>b.maxX-200 || w[i-1]<b.minZ+200 || w[i-1]>b.maxZ-200) continue;
        playerCar.setPosition(w[i-2]+dx/len*10,w[i-1]+dz/len*10,Math.atan2(dx,-dz)*180/Math.PI);
        const before=playerCar.info(), roadBefore=chaseRoadMeters;
        carKeys.add('KeyW'); stepChaseFlight(3); carKeys.clear();
        const after=playerCar.info();
        const measured=chaseRoadMeters-roadBefore;
        const moved=Math.hypot(after.x-before.x,after.z-before.z);
        const crewBefore=[chaseCar.info(),chaseCar2.info()];
        state.pos.y=terrain.getHeight(state.pos.x,state.pos.z)+100; state.grounded=false;
        remaining=0.001; dropMarker(); carKeys.add('KeyW'); stepChaseFlight(1/60);
        const atTimeout=chaseRoadMeters;
        stepChaseFlight(.2); carKeys.clear();
        return {measured,moved,atTimeout,afterTimeout:chaseRoadMeters,crewBefore,
          crewAfter:[chaseCar.info(),chaseCar2.info()]};
      }
    }
    throw new Error('実道路に検証用の直線区間が見つかりません');
  },
  start: (x, z) => startFlight(x, z),
  drive: dt => stepChaseFlight(dt),
  viewCase: (distance, alt, withMarker = false) => {
    playerCar.setPosition(-distance/2,0);
    state.pos.set(distance/2,alt,distance/4); state.grounded=false;
    balloon.group.position.copy(state.pos);
    if (withMarker) {
      dropMarker(); marker.state.pos.set(0,alt/2,-distance/4);
      marker.mesh.position.copy(marker.state.pos);
    }
    updateChaseCamera(1/60); renderer.render(scene,camera);
    return [playerCar.group.position, state.pos, ...(marker.state ? [marker.state.pos] : [])]
      .map(p => p.clone().project(camera).toArray());
  },
  reset: (x, z, rows) => {
    for (const c of [chaseCar,chaseCar2]) if(c) scene.remove(c.group);
    chaseCar=null; chaseCar2=null;
    if (playerCar) scene.remove(playerCar.group);
    if (marker.mesh) scene.remove(marker.mesh);
    marker.state = null; marker.mesh = null; marker.available = 1;
    chaseFinished = false; expired = false; remaining = TASK_LIMIT_S;
    state.fuel = 100; started = false; input.burner = false; input.rip = false;
    PIBAL = rows || WIND_PRESETS[0].rows.map(toRowObj);
    document.getElementById('result').style.display = 'none';
    startFlight(x, z);
  },
  simulate: (seconds, dt = 0.2) => {
    let elapsed = 0, minDistance = Infinity;
    for (; elapsed < seconds && !chaseFinished; elapsed += dt) {
      stepChaseFlight(dt);
      minDistance = Math.min(minDistance, Math.hypot(state.pos.x, state.pos.z));
    }
    return {elapsed, minDistance, dropped: !!marker.state, landed: !!marker.state?.landed,
      altitude: state.pos.y, grounded: state.grounded, fuel: state.fuel,
      result: document.getElementById('result-sub').textContent};
  },
  nearLanding: dist => {
    state.pos.set(0, terrain.getHeight(0,0) + 1, 0); state.grounded = false;
    dropMarker(); marker.state.pos.y = terrain.getHeight(0,0) + 0.01;
    marker.state.vel.set(0,-10,0); playerCar.setPosition(dist,0);
    stepChaseFlight(1/60);
  },
  expire: () => { remaining = 0.001; stepChaseFlight(1/60); },
  lateLanding: () => {
    state.pos.set(0,terrain.getHeight(0,0)+50,0); state.grounded=false;
    dropMarker(); remaining=0.001; stepChaseFlight(1/60);
    const waiting = expired && !chaseFinished;
    marker.state.pos.set(0,terrain.getHeight(0,0)+0.01,0);
    marker.state.vel.set(0,-10,0); playerCar.setPosition(0,0);
    stepChaseFlight(1/60);
    return {waiting, finished:chaseFinished};
  },
  leaveBounds: () => {
    state.pos.set(chaseBounds.maxX+100,1000,0); state.grounded=false;
    stepChaseFlight(1/60);
  },
  rejectDrop: () => {
    const ap = createBalloonAutopilot({windAt, targetX:0, targetZ:0});
    return [ap.shouldDrop({x:0,z:0}), ap.shouldDrop({x:0,z:0}),
      (ap.markDropped(), ap.shouldDrop({x:0,z:0}))];
  },
  highGround: () => {
    const ap = createBalloonAutopilot({windAt, getHeight: () => 2000, targetX:0, targetZ:0});
    const ctrl = ap.control({x:0,y:2000,z:0},0,1/60);
    return {ctrl, ft: ap.cruiseFt()};
  },
  bounds: () => {
    const car = createPlayerCar({getHeight: terrain.getHeight, startX:1e6,startZ:-1e6,bounds:chaseBounds});
    for (let i=0;i<500;i++) car.update(.1,{throttle:1,steer:-1});
    return {info:car.info(), bounds:chaseBounds};
  },
};
`;
// 一時停止中も実際の描画ループを動かして検証する。
const instrumented = source.replace('renderer.setAnimationLoop(() => {', 'const loopForTest = () => {')
  .replace(/\}\);\s*$/, '}; renderer.setAnimationLoop(loopForTest);');
const browser = await chromium.launch({ headless: true });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route('**/prototype/main.js', route => route.fulfill({
  contentType: 'text/javascript; charset=utf-8', body: instrumented + hook,
}));
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
const origin = process.env.CHASE_URL || 'http://127.0.0.1:8000/prototype/';
async function ready(query) {
  await page.goto(origin + query, { waitUntil: 'domcontentloaded' });
  if (new URLSearchParams(query).has('setup') || new URLSearchParams(query).has('dev')) {
    await page.locator('#area-presets button').first().click();
    await page.locator('#area-btn').click();
  }
  await page.waitForFunction(() => !!window.chaseTest, null, { timeout: 90000 });
}
try {
  await ready('?mode=chase');
  await page.waitForFunction(() => window.chaseTest.roadReady(), null, {timeout:90000});
  await page.locator('#chase-pause-btn').click();
  const pausedBefore = await page.evaluate(() => window.chaseTest.snap());
  await page.waitForTimeout(700);
  const pausedAfter = await page.evaluate(() => window.chaseTest.snap());
  for (const key of ['pos','car','crew','remaining','roadMeters']) assert.deepEqual(pausedAfter[key],pausedBefore[key]);
  await page.locator('#chase-overview-btn').click();
  assert((await page.evaluate(() => window.chaseTest.snap())).overview);
  await page.locator('#chase-overview-btn').click();
  await page.locator('#chase-pause-btn').click();
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)) });
  await page.evaluate(() => window.chaseTest.stop());
  let snap = await page.evaluate(() => window.chaseTest.snap());
  assert(snap.started && snap.chaseMode && snap.car && !snap.controls && snap.autoCars);
  assert(snap.url.includes('mode=chase'));
  const roadTrial=await page.evaluate(() => window.chaseTest.roadTrial());
  assert(roadTrial.measured > 30 && Math.abs(roadTrial.measured-roadTrial.moved)<0.01);
  assert.equal(roadTrial.afterTimeout,roadTrial.atTimeout);
  assert.notDeepEqual(roadTrial.crewBefore,roadTrial.crewAfter);
  console.log('real road distance OK',JSON.stringify(roadTrial));
  await page.evaluate(() => window.chaseTest.reset(-1267.8548,2718.9234));
  const panels = ['instruments','chase-readout','pibal','help-keys','credit'];
  const panelState = () => page.evaluate(ids => ids.map(id => document.getElementById(id).open), panels);
  assert.deepEqual(await panelState(), [false,false,false,false,false]);
  await page.locator('#instruments summary').click();
  await page.locator('#pibal summary').click();
  const panelBefore = await panelState();
  await page.locator('#chase-panels-btn').click();
  assert.deepEqual(await panelState(), [false,false,false,false,false]);
  await page.locator('#chase-panels-btn').click();
  assert.deepEqual(await panelState(), panelBefore);
  await page.locator('#chase-panels-btn').click();
  await page.keyboard.press('v');
  await page.locator('#chase-overview-btn').click();
  for (const [distance,alt] of [[50,30],[3000,900],[16000,2000]]) {
    const projections = await page.evaluate(([d,a]) => window.chaseTest.viewCase(d,a), [distance,alt]);
    for (const p of projections) assert(p.every(Number.isFinite) && p.every(v => Math.abs(v) < 1));
  }
  await page.evaluate(() => window.chaseTest.viewCase(3000,900,true));
  assert(await page.locator('.chase-map-marker').isVisible());
  await page.screenshot({path:fileURLToPath(new URL('overview-desktop.png',output))});
  await page.locator('#chase-overview-btn').click();
  snap = await page.evaluate(() => window.chaseTest.snap());
  assert(!snap.overview && snap.look);
  assert(await page.locator('#chase-overview-labels').isHidden());
  await page.keyboard.press('v');
  await page.evaluate(() => window.chaseTest.reset(-1267.8548,2718.9234));
  await page.keyboard.down('w');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.up('w');
  await page.evaluate(() => window.chaseTest.drive(1));
  snap = await page.evaluate(() => window.chaseTest.snap());
  assert(snap.car.speedKmh > 0 && snap.keys.includes('ArrowUp'));
  await page.keyboard.up('ArrowUp');
  await page.keyboard.press('v');
  assert((await page.evaluate(() => window.chaseTest.snap())).look);
  await page.keyboard.down('w');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await page.evaluate(() => window.chaseTest.snap())).keys.length, 0);
  await page.keyboard.up('w');
  assert.deepEqual(await page.evaluate(() => window.chaseTest.rejectDrop()), [true,true,false]);
  const high = await page.evaluate(() => window.chaseTest.highGround());
  assert(high.ctrl.burner && high.ft > 2000 * 3.28084);
  const edge = await page.evaluate(() => window.chaseTest.bounds());
  assert(edge.info.x >= edge.bounds.minX + 50 && edge.info.x <= edge.bounds.maxX - 50);
  assert(edge.info.z >= edge.bounds.minZ + 50 && edge.info.z <= edge.bounds.maxZ - 50);
  assert(edge.info.headingDeg >= 0 && edge.info.headingDeg < 360);
  await page.evaluate(() => localStorage.setItem('balloon-jdg-proto-best','12.3'));
  for (const dist of [20, 31]) {
    await page.evaluate(dist => { window.chaseTest.reset(0,0); window.chaseTest.nearLanding(dist); }, dist);
    const result = await page.locator('#result-sub').innerText();
    assert(result.includes(dist === 20 ? '回収成功' : '回収できません'));
    assert(result.includes(dist === 20 ? '回収 1000点' : '回収 0点'));
    assert((await page.evaluate(() => window.chaseTest.snap())).chaseFinished);
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('balloon-jdg-proto-best')), '12.3');
  await page.evaluate(() => { window.chaseTest.reset(3000,0); window.chaseTest.expire(); });
  assert((await page.locator('#result-sub').innerText()).includes('時間切れ'));
  assert(await page.locator('#result .r-dist').isHidden());
  await page.evaluate(() => window.chaseTest.reset(0,0));
  assert.deepEqual(await page.evaluate(() => window.chaseTest.lateLanding()), {waiting:true,finished:true});
  await page.evaluate(() => { window.chaseTest.reset(3000,0); window.chaseTest.leaveBounds(); });
  assert((await page.locator('#result-sub').innerText()).includes('範囲の外'));
  const finished = await page.evaluate(() => window.chaseTest.snap());
  await page.evaluate(() => window.chaseTest.drive(1));
  assert.deepEqual((await page.evaluate(() => window.chaseTest.snap())).car, finished.car);
  const trials = [];
  for (const [name, x, z, rows, dt] of [
    ['20m start', 0,20,null,.2], ['400m start',0,400,null,.2],
    ['default wind',-1267.8548,2718.9234,null,.2],
    ['default wind x8',-1267.8548,2718.9234,null,.4],
    ['calm',0,1100,[{ft:0,dir:0,kt:0}],.2],
  ]) {
    await page.evaluate(({x,z,rows}) => window.chaseTest.reset(x,z,rows), {x,z,rows});
    const trial = await page.evaluate(dt => window.chaseTest.simulate(1801,dt), dt);
    assert(Number.isFinite(trial.altitude));
    assert(trial.result.length > 0);
    if (name === '20m start') assert(trial.dropped && trial.landed);
    trials.push({name,...trial});
  }
  console.log('flight trials', JSON.stringify(trials));
  assert.equal(trials[2].altitude, trials[3].altitude);
  assert.equal(trials[2].minDistance, trials[3].minDistance);
  for (const query of ['?mode=flight', '?mode=flight&setup=1', '?mode=flight&a=130.25,33.27', '?mode=flight&dev=1']) {
    await ready(query);
    if (query) {
      await page.evaluate(() => window.chaseTest.start(-1267,2719));
    }
    await page.waitForFunction(() => Number(document.getElementById('clock').textContent.slice(3)) < 59);
    snap = await page.evaluate(() => window.chaseTest.snap());
    assert(snap.started && !snap.chaseMode && !snap.car && !snap.dropped);
    assert(snap.grounded && snap.controls);
    assert(await page.locator('#chase-readout').isHidden());
    assert(await page.locator('#chase-actions').isHidden());
    assert.equal(await page.locator('#pibal').evaluate(el => el.tagName), 'DIV');
    await page.keyboard.down('Space');
    await page.waitForTimeout(600);
    await page.keyboard.up('Space');
    assert((await page.evaluate(() => window.chaseTest.snap())).fuel < snap.fuel);
    console.log('entry OK', query || 'default');
  }
  const mobile = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await mobile.route('**/prototype/main.js', route => route.fulfill({contentType:'text/javascript',body:instrumented+hook}));
  const touch = await mobile.newPage();
  touch.on('pageerror', e => errors.push(e.message));
  await touch.goto(origin + '?mode=chase', {waitUntil:'domcontentloaded'});
  await touch.waitForFunction(() => !!window.chaseTest, null, {timeout:90000});
  assert(await touch.locator('[data-car-key="forward"]').isVisible());
  assert(await touch.locator('#tc-burner').isHidden());
  await touch.locator('[data-car-key="forward"]').dispatchEvent('pointerdown');
  await touch.waitForTimeout(600);
  await touch.locator('[data-car-key="forward"]').dispatchEvent('pointercancel');
  const ts = await touch.evaluate(() => window.chaseTest.snap());
  assert(ts.car.speedKmh > 0 && ts.keys.length === 0);
  await touch.screenshot({ path: fileURLToPath(new URL('mobile.png', output)) });
  await touch.evaluate(() => window.chaseTest.stop());
  await touch.locator('#chase-overview-btn').tap();
  for (const viewport of [{width:390,height:844},{width:844,height:390}]) {
    await touch.setViewportSize(viewport);
    const projections = await touch.evaluate(() => window.chaseTest.viewCase(6000,1800));
    for (const p of projections) assert(p.every(Number.isFinite) && p.every(v => Math.abs(v) < 1));
    await touch.screenshot({path:fileURLToPath(new URL('overview-mobile-'+viewport.width+'.png',output))});
    const actionBox = await touch.locator('#chase-actions').boundingBox();
    const driveBox = await touch.locator('#touch-controls').boundingBox();
    assert(actionBox.y + actionBox.height <= driveBox.y);
  }
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log('PASS: input, capture, timeout, autopilot, bounds, four entries, mobile, no page errors');
} finally {
  await browser.close();
}

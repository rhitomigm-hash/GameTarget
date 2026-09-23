import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chasePoints } from '../../prototype/chaseScore.js';
const source = await readFile(new URL('../../prototype/main.js', import.meta.url), 'utf8');
const start = source.indexOf('function onMarkerLanded(');
const section = source.slice(start, source.indexOf("document.getElementById('result-retry')", start));
assert.ok(section.includes('function stepChaseFlight'));
function trial(distance, expired) {
  const elements = new Map(), saved = new Map(), car = { x: distance, z: 0 };
  const get = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', hidden: false });
    return elements.get(id);
  };
  const c = {
    document: { getElementById: get, querySelector: get },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) },
    chaseOverview: false, chaseObserving: false, chasePoints, chaseWindReported: false, chaseMode: true, chaseFinished: false, expired, remaining: expired ? 0 : 100,
    input: {}, clearCarInput() {}, CHASE_CATCH_RADIUS_M: 30, CHASE_BEST_KEY: 'best',
    chaseRoadMeters: 1000, playerCar: { info: () => car, update() {} },
    marker: { available: 0, state: {
      landed: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 100000, z: 100000 },
    } },
    announceBalloon: message => { get('radio').textContent = message; },
    hud: { clock: get('clock') }, windAt: () => ({ vx: 0, vz: 0, kt: 0 }),
    state: { pos: { x: 0, y: 100, z: 0 }, vy: 0, fuel: 100, grounded: false },
    autopilot: { control: () => ({}) }, stepPhysics: () => ({ kt: 0 }), stepMarker() {},
    carKeys: new Set(), chaseCar: null, chaseCar2: null,
    chaseRoadMeter: { measure() { throw Error('Road score must stop after landing'); } },
    chaseBounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  };
  vm.createContext(c);
  vm.runInContext(section, c);
  c.onMarkerLanded(c.marker.state.pos);
  if (distance <= 30) {
    assert.ok(c.chaseFinished);
    assert.match(get('result-sub').textContent, /回収 1000点/);
  } else {
    assert.equal(c.chaseFinished, false);
    assert.match(get('radio').textContent, /500点/);
    c.stepChaseFlight(1 / 60);
    assert.equal(c.chaseFinished, false);
    car.x = 30;
    c.stepChaseFlight(8 / 60);
    assert.ok(c.chaseFinished);
    assert.match(get('result-sub').textContent, /回収 500点/);
    assert.equal(get('result-dist').textContent, distance.toFixed(1));
    assert.equal(saved.get('best'), distance.toFixed(1));
    const result = get('result-sub').textContent;
    c.stepChaseFlight(1);
    assert.equal(get('result-sub').textContent, result);
  }
  assert.equal(c.chaseRoadMeters, 1000);
}
for (const expired of [false, true]) {
  for (const distance of [0, 30, 30.01, 500]) trial(distance, expired);
}
console.log('PASS: ground recovery, 30m boundary, timeout, 1000/500 points, no duplicate award, landing record, road score cutoff, stationary marker');

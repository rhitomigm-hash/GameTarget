import assert from 'node:assert/strict';
import { createRoadMeter, chasePoints } from '../../prototype/chaseScore.js';
const edge = (world, props = {rnkWidth:0}) => ({world, props});
const graph = {edges: new Map([['a',edge([0,0,100,0])],['duplicate',edge([0,0,100,0])]])};
const meter = createRoadMeter(graph);
const p = (x,z) => ({x,z});
assert.equal(meter.measure(p(0,0),p(100,0)),100);
assert.equal(meter.measure(p(100,0),p(0,0)),100); // 往復は加点。重複した道路線は二重加点しない
assert.equal(meter.measure(p(0,10),p(100,10)),0);
assert.equal(meter.measure(p(50,0),p(50,0)),0);
assert.equal(meter.measure(p(50,-10),p(50,10)),7); // 横断は道路の幅だけ
graph.edges.set('new',edge([200,0,300,0]));
assert.equal(meter.measure(p(200,0),p(300,0)),100); // 後から読んだタイル
graph.edges.set('motorway',edge([0,100,100,100],{rnkWidth:2,motorway:1}));
assert.equal(meter.measure(p(0,100),p(100,100)),0);
let smallSteps=0;
for(let x=0;x<100;x++)smallSteps+=meter.measure(p(x,0),p(x+1,0));
assert.equal(smallSteps,meter.measure(p(0,0),p(100,0)));
assert.deepEqual(chasePoints(true,1099),{recovery:1000,road:10,total:1010});
assert.deepEqual(chasePoints(false,36000),{recovery:0,road:360,total:360});
console.log('PASS: 道路距離・横断・道路外・停止・往復・重複・追加タイル・高速道路除外・刻み・採点');

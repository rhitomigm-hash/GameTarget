// 新ゲームモード「マーカー回収レース」: プレイヤーが直接操縦する車(フェーズ1 = 自由走行)。
//
// chasecar.js の車(A*で道路網を自動走行する地上クルー)とは別物。
// こちらは道路グラフを一切見ず、地形(DEM)の上をアクセル・ハンドルで自由に走らせる。
// 「気球を見ながら先読みして待つ」という遊びの核がまず面白いかどうかを、
// いちばん軽い実装で検証するためのフェーズ1。
//
// フェーズ2(道路グラフに沿った走行)へ拡張するときも、この update() の
// シグネチャ(dt, input)はそのまま保ち、中身だけ「辺の上を進む」処理に
// 差し替えられるよう意識して作ってある。
import * as THREE from 'three';

// 走行性能(目安値。実車の数値ではなくアーケード的な操作感を優先)
const MAX_SPEED_MPS = 20;       // 前進の上限(≒72km/h)
const MAX_REVERSE_MPS = 6;      // バックの上限
const ACCEL_MPS2 = 8;           // アクセルを踏んだときの加速度
const BRAKE_MPS2 = 14;          // 逆入力(進行方向と反対のキー)時の減速度。ブレーキ役を兼ねる
const FRICTION_MPS2 = 4;        // 入力が無いときの自然減速(空走で少しずつ止まる)
const MAX_STEER_RATE = 2.4;     // 低速時の最大ハンドル角速度(rad/s)
const MIN_STEER_SPEED_MPS = 1.0; // これより遅いとハンドルがほぼ効かない(据え切り防止)
const TURN_VISUAL_RATE = 6.0;   // 車体の見た目の向きが追従する速さ(急な回転をなめらかに見せる)

// 自由走行版は道路の描画面に依存せず、地面のすぐ上に置く。
const CAR_LIFT = 0.05;

// 車体(見た目)。chasecar.js の 'car'(自家用車型)に似せた簡易版。
// プレイヤー車と分かるよう、既定色は chasecar.js の2号車とも1号車とも違う色にしてある
function buildPlayerCarMesh(bodyColor = 0xffb300) {
  const group = new THREE.Group();
  group.name = 'player-car';

  const box = (w, h, l, y, z, color) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, l),
      new THREE.MeshLambertMaterial({ color }),
    );
    m.position.set(0, y, z);
    return m;
  };

  // 寸法は chasecar.js の CAR_SHAPES.car とだいたい揃えてある(全長4.3m級)
  group.add(box(1.75, 0.78, 4.30, 0.39, 0, bodyColor));
  group.add(box(1.58, 0.56, 2.10, 1.06, 0.25, bodyColor));
  // フロントガラス(局所 -Z 側 = 前)。前後を見分けるための面
  group.add(box(1.50, 0.46, 0.10, 1.06, -0.80, 0x2a3442));
  // テールランプ(後ろが分かるよう、局所 +Z 側に小さな赤を1つ)
  group.add(box(1.60, 0.12, 0.08, 0.55, 2.10, 0xd32f2f));

  return group;
}

/**
 * プレイヤー操縦の車を作る(フェーズ1: 自由走行)。
 *
 * @param {object} opts
 * @param {(x:number,z:number)=>number} opts.getHeight terrain.js の getHeight
 * @param {number} opts.startX 初期位置
 * @param {number} opts.startZ
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} [opts.bounds=null]
 *   ここから外へは出さない。**地形(DEM)の範囲**を渡すこと。chasecar.js と同じ理由
 *   (外へ出ると getHeight が 0 を返し、車が地面の下に埋まって見えなくなる)
 * @param {number} [opts.bodyColor=0xffb300] 車体の色
 * @param {number} [opts.headingDeg=0] 初期の向き(度、北0・時計回り)
 * @returns {{group:THREE.Group, update:Function, info:Function}}
 */
export function createPlayerCar({
  getHeight, startX = 0, startZ = 0, bounds = null, bodyColor = 0xffb300, headingDeg = 0,
}) {
  const group = buildPlayerCarMesh(bodyColor);

  const car = {
    x: startX, z: startZ,
    speed: 0,                                   // 符号付き(前進+ / バック-)
    heading: (headingDeg * Math.PI) / 180,       // 実際の進行方向(物理)
    visualHeading: (headingDeg * Math.PI) / 180, // 見た目の向き(なめらかに追従させる)
  };

  // bounds の少し内側で止める(chasecar.js の margined と同じ考え方)。
  // ぴったり境界で止めると、境界付近の getHeight がタイルの継ぎ目で不安定なことがあるため
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function clampToBounds() {
    if (!bounds) return;
    const m = 50;
    car.x = clamp(car.x, bounds.minX + m, bounds.maxX - m);
    car.z = clamp(car.z, bounds.minZ + m, bounds.maxZ - m);
  }

  function place() {
    group.position.set(car.x, getHeight(car.x, car.z) + CAR_LIFT, car.z);
    // -heading の理由は chasecar.js の place() と同じ:
    // この世界の進行方向 (sinθ, -cosθ) と three.js の Y回転を局所 -Z に合わせるため
    group.rotation.y = -car.visualHeading;
  }
  clampToBounds();
  place();

  /**
   * @param {number} dt 経過秒
   * @param {{throttle:number, steer:number}} input
   *   throttle: -1(バック)〜+1(前進)。0で入力なし
   *   steer:    -1(左)〜+1(右)。0で直進
   *   (main.js 側でキー入力をこの2軸に変換して渡す)
   */
  function update(dt, input = { throttle: 0, steer: 0 }) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const throttle = clamp(input.throttle ?? 0, -1, 1);
    const steer = clamp(input.steer ?? 0, -1, 1);

    // 加減速。逆入力(前進中にバック入力、バック中に前進入力)はブレーキとして強めに効かせる。
    // 例: 前進中(movingForward)にバック入力(throttle<0) → BRAKE_MPS2 で強く減速
    //     停止・低速中にバック入力 → ACCEL_MPS2*0.7 でゆっくりバック発進
    const movingForward = car.speed > 0.05, movingBack = car.speed < -0.05;
    if (Math.abs(throttle) < 0.01) {
      // 入力が無いときは自然減速で0へ近づける
      const dec = FRICTION_MPS2 * dt;
      car.speed = car.speed > 0 ? Math.max(0, car.speed - dec) : Math.min(0, car.speed + dec);
    } else if (throttle > 0) {
      const a = movingBack ? BRAKE_MPS2 : ACCEL_MPS2;
      car.speed += a * throttle * dt;
    } else {
      const a = movingForward ? BRAKE_MPS2 : ACCEL_MPS2 * 0.7;
      car.speed += a * throttle * dt; // throttle が負なので自動的に減算になる
    }
    car.speed = clamp(car.speed, -MAX_REVERSE_MPS, MAX_SPEED_MPS);

    // ハンドル。速度に応じて効きを変える(低速では効きにくく、バック中は左右が逆になる)
    if (Math.abs(car.speed) > MIN_STEER_SPEED_MPS) {
      const speedFactor = Math.min(1, Math.abs(car.speed) / 6); // 低速ほど小回り、というより効き始めの目安
      const dir = car.speed >= 0 ? 1 : -1;
      car.heading += steer * MAX_STEER_RATE * speedFactor * dir * dt;
    }

    // 位置更新(前進方向は (sinθ, -cosθ)。chasecar.js と同じ座標系)
    car.heading = ((car.heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    car.x += Math.sin(car.heading) * car.speed * dt;
    car.z += -Math.cos(car.heading) * car.speed * dt;
    const nextX = car.x, nextZ = car.z;
    clampToBounds();
    if (car.x !== nextX || car.z !== nextZ) car.speed = 0;

    // 見た目の向きはなめらかに追従(急なハンドル操作でもカクつかせない)
    let diff = car.heading - car.visualHeading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    car.visualHeading += diff * Math.min(1, dt * TURN_VISUAL_RATE);

    place();
  }

  // 現在の状態(HUD表示・捕獲判定などで使う)
  function info() {
    return {
      x: car.x, z: car.z,
      y: group.position.y,
      headingDeg: ((car.heading * 180) / Math.PI + 360) % 360,
      speedKmh: Math.round((car.speed * 3600) / 1000),
      speedMps: car.speed,
    };
  }

  // 気球側から見た「初期位置をどこに置くか」を後から決めたいケース用(離陸地点確定後、等)
  function setPosition(x, z, hd = null) {
    car.x = x; car.z = z; car.speed = 0;
    if (hd !== null) { car.heading = (hd * Math.PI) / 180; car.visualHeading = car.heading; }
    clampToBounds();
    place();
  }

  return { group, update, info, setPosition };
}

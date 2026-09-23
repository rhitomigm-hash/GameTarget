// 新ゲームモード「マーカー回収レース」: ダミー気球のオートパイロット。
//
// **気球の物理そのものには触れない。** main.js の stepPhysics(浮力・風の反映・
// 接地判定)はプレイヤー操縦時と完全に同じものを使う。このモジュールが決めるのは
// 「バーナー(input.burner)とリップライン(input.rip)を、キーボードの代わりに
// 何が true/false にするか」だけ。マーカーの投下タイミングも同様に「要求する」だけで、
// 実際の投下(dropMarker)・落下物理(stepMarker)は main.js 側の既存実装を呼ぶ。
//
// 設計方針(先読みゲームとしての狙い):
//   プレイヤーは「気球が今どの高度でどちらへ流れているか」をパイバル表と見た目から
//   読み、着地点を予測して先回りする。そのため、この気球は**気まぐれに動かない**
//   (毎フレーム巡航高度を変えたりしない)。巡航高度は一定間隔でしか選び直さないので、
//   プレイヤーが「しばらくこの高度・この向きで飛ぶ」と当てを付けられる状態を保つ。

const DEFAULT_CRUISE_SCAN_FT = [500, 1000, 1500, 2000, 3000, 5000]; // 巡航候補高度
const DEADBAND_M = 15;     // 目標高度からの不感帯(この中では焚きもリップもしない)
const VY_GUARD_MPS = 2.5;  // 昇降が既にこの速さで目標へ向かっているなら追加入力しない(オーバーシュート防止)
const RESCAN_S = 25;       // 巡航高度を選び直す間隔(秒)。頻繁に変えるとプレイヤーが読めなくなる
const MIN_CLEARANCE_M = 100; // ゲーム内の地形追従用。実飛行の安全高度を示す値ではない

/**
 * ダミー気球のオートパイロットを作る。
 *
 * @param {object} opts
 * @param {(altM:number,x:number,z:number)=>{dir:number,kt:number,vx:number,vz:number}} opts.windAt
 *   main.js の windAt と同じシグネチャ。地点・高度ごとの風を返す
 * @param {(x:number,z:number)=>number} [opts.getHeight] 候補高度を地形より上に置くための標高
 * @param {number} opts.targetX ターゲット(マーカーを落としたい場所の目安)
 * @param {number} opts.targetZ
 * @param {number} [opts.M2FT=3.28084]
 * @param {number} [opts.dropDistM=400] ターゲットからこの距離まで近づいたら投下を要求する。
 *   **ちょうど真上で投下するわけではない**(そうすると先読みの意味が薄れる)。
 *   風で流れることを見込んだ距離感は、パイバル表を見て早めに動くプレイヤー側の腕の見せどころ
 * @param {number[]} [opts.cruiseScanFt] 巡航高度の候補(ft)
 * @returns {{control:Function, shouldDrop:Function, markDropped:Function, cruiseFt:()=>number|null}}
 */
export function createBalloonAutopilot({
  windAt, targetX, targetZ, getHeight = () => 0, M2FT = 3.28084, dropDistM = 400,
  cruiseScanFt = DEFAULT_CRUISE_SCAN_FT,
}) {
  let cruiseFt = null;
  let sinceScan = 1e9;   // 初回は即座に選ぶ
  let dropped = false;
  let dropAnnounced = false;

  // 現在地からターゲットへ、いちばん近い方位で運んでくれる高度を選ぶ。
  // 「方位の近さ」と「風速」の両方を見る(弱い風だと方位が合っていても進まない)
  function pickCruiseAltitude(x, z) {
    const toTarget = Math.atan2(targetX - x, -(targetZ - z)); // 目的地への方位
    const minFt = (getHeight(x, z) + MIN_CLEARANCE_M) * M2FT;
    const candidates = cruiseScanFt.filter(ft => Number.isFinite(ft) && ft >= minFt);
    if (!candidates.length) candidates.push(Math.ceil(minFt / 500) * 500);
    let best = candidates[0], bestScore = -Infinity;
    for (const ft of candidates) {
      const w = windAt(ft / M2FT, x, z);
      if (w.kt < 1) continue; // ほぼ無風の高度は候補にしない
      const blowTo = Math.atan2(w.vx, -w.vz); // 風が吹いていく向き
      let diff = Math.abs(toTarget - blowTo);
      while (diff > Math.PI) diff -= Math.PI * 2; // -π..π に畳んでから絶対値
      diff = Math.abs(diff);
      const score = Math.cos(diff) * w.kt; // 向きが合っていて速いほど高スコア
      if (score > bestScore) { bestScore = score; best = ft; }
    }
    return best;
  }

  return {
    /**
     * 毎フレーム呼ぶ。戻り値をそのまま main.js の input.burner / input.rip に代入する想定
     * @param {{x:number,y:number,z:number}} pos 気球の現在位置(標高m)
     * @param {number} vy 現在の昇降速度(m/s)
     * @param {number} dt 経過秒
     */
    control(pos, vy, dt) {
      sinceScan += dt;
      if (cruiseFt === null || sinceScan >= RESCAN_S) {
        cruiseFt = pickCruiseAltitude(pos.x, pos.z);
        sinceScan = 0;
      }
      const targetM = Math.max(cruiseFt / M2FT, getHeight(pos.x, pos.z) + MIN_CLEARANCE_M);
      const diffM = targetM - pos.y;
      // ヒステリシス: 不感帯の外に出ていて、かつ既に目標方向へ十分な速さで
      // 動いていないときだけ入力する(焚きすぎ・抜きすぎで往復するのを防ぐ)
      const burner = diffM > DEADBAND_M && vy < VY_GUARD_MPS;
      const rip = diffM < -DEADBAND_M && vy > -VY_GUARD_MPS;
      return { burner, rip };
    },

    // 要求するだけ。接地中などに dropMarker() が拒否しても再試行できるよう、
    // 実際に投下できた後で呼び出し側が markDropped() を呼ぶ。
    shouldDrop(pos) {
      if (dropped) return false;
      const d = Math.hypot(pos.x - targetX, pos.z - targetZ);
      return d <= dropDistM;
    },

    // 現在の風による到達予測。高度・風が変われば時刻も前後する。
    dropNotice(pos) {
      if (dropped || dropAnnounced) return null;
      const x = pos.x - targetX, z = pos.z - targetZ;
      const c = x * x + z * z - dropDistM * dropDistM;
      let seconds = 0;
      if (c > 0) {
        const { vx, vz } = windAt(pos.y, pos.x, pos.z);
        const a = vx * vx + vz * vz, b = x * vx + z * vz;
        const discriminant = b * b - a * c;
        if (a <= 0 || b >= 0 || discriminant < 0) return null;
        seconds = c / (-b + Math.sqrt(discriminant));
      }
      if (!Number.isFinite(seconds) || seconds > 60) return null;
      dropAnnounced = true;
      return seconds;
    },

    markDropped() { dropped = true; },

    cruiseFt: () => cruiseFt,
  };
}

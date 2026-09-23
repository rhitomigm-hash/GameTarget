import * as THREE from 'three';
// SORAのゴンドラと同じ視線回転。位置は固定、ズームは画角のみ。
export function createStoppedCamera({camera, element, canMove, render}) {
  let active=false, yaw=0, pitch=0;
  const originalFov=camera.fov;
  const pointers=new Map();
  function reset(){active=false;pointers.clear();if(camera.fov!==originalFov){camera.fov=originalFov;camera.updateProjectionMatrix();}}
  function move(dx,dy,dolly=0){
    if(!canMove()){reset();return;}
    if(!active){const direction=new THREE.Vector3();camera.getWorldDirection(direction);yaw=Math.atan2(direction.x,-direction.z);pitch=Math.asin(THREE.MathUtils.clamp(direction.y,-1,1));}
    yaw-=dx*.0038;
    pitch=THREE.MathUtils.clamp(pitch-dy*.0038,-THREE.MathUtils.degToRad(85),THREE.MathUtils.degToRad(85));
    const cy=Math.cos(pitch);
    camera.lookAt(camera.position.x+Math.sin(yaw)*cy,camera.position.y+Math.sin(pitch),camera.position.z-Math.cos(yaw)*cy);
    camera.fov=THREE.MathUtils.clamp(camera.fov-dolly,25,85);camera.updateProjectionMatrix();
    active=true;render();
  }
  element.style.touchAction='none';
  element.addEventListener('pointerdown',e=>{
    if(!canMove() || (e.pointerType==='mouse' && e.button!==0))return;
    element.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  });
  element.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    const prev=pointers.get(e.pointerId),next={x:e.clientX,y:e.clientY};
    if(pointers.size===2){
      const other=[...pointers.entries()].find(([id])=>id!==e.pointerId)[1];
      move(0,0,(Math.hypot(next.x-other.x,next.y-other.y)-Math.hypot(prev.x-other.x,prev.y-other.y))*.15);
    }else move(next.x-prev.x,next.y-prev.y);
    if(canMove())pointers.set(e.pointerId,next);
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])element.addEventListener(name,e=>pointers.delete(e.pointerId));
  element.addEventListener('wheel',e=>{if(canMove()){e.preventDefault();move(0,0,-Math.max(-200,Math.min(200,e.deltaY))*.08);}},{passive:false});
  return {reset,get active(){return active;}};
}

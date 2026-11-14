import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { state, saveLocalState } from "./state.js";
import { confirmarModal, toast } from "./modal.js";
import { insertDiceRoll, scheduleSync } from "./supabase.js";

let scene, camera, renderer, diceMeshes = [], animationId = 0, rolling = false, resizeObserver;
const stage = document.getElementById("dice-stage");
const geometryFor = sides => {
  if (sides === 4) return new THREE.TetrahedronGeometry(1.12, 0);
  if (sides === 6) return new THREE.BoxGeometry(1.45, 1.45, 1.45);
  if (sides === 8) return new THREE.OctahedronGeometry(1.12, 0);
  if (sides === 10) return new THREE.CylinderGeometry(.82, .82, 1.25, 10, 1, false, Math.PI / 10);
  if (sides === 12) return new THREE.DodecahedronGeometry(1.1, 0);
  return new THREE.IcosahedronGeometry(1.1, 0);
};
function makeFaceMaterials(sides, offset = 0) {
  const count = sides === 6 ? 6 : sides === 4 ? 4 : sides === 8 ? 8 : sides === 10 ? 10 : sides === 12 ? 12 : 20;
  return Array.from({ length: count }, (_, i) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = `hsl(${145 + i * 7}, 38%, 28%)`; ctx.fillRect(0,0,256,256);
    ctx.strokeStyle = "#d8f7b8"; ctx.lineWidth = 9; ctx.strokeRect(8,8,240,240);
    ctx.fillStyle = "#f4f8ee"; ctx.font = "bold 94px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(i + 1 + offset),128,130);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({ map: texture, roughness: .45, metalness: .12 });
  });
}
function initScene() {
  scene = new THREE.Scene(); scene.background = null;
  camera = new THREE.PerspectiveCamera(35, 1, .1, 100); camera.position.set(0, 3.4, 7.8); camera.lookAt(0,0,0);
  renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; stage.innerHTML = ""; stage.append(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x34404b, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(-3,6,5); light.castShadow = true; scene.add(light);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5,48), new THREE.ShadowMaterial({ opacity:.18 })); floor.rotation.x = -Math.PI/2; floor.position.y = -1.05; floor.receiveShadow = true; scene.add(floor);
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage); resize();
  const loop = () => { animationId = requestAnimationFrame(loop); if (!rolling) diceMeshes.forEach(d => { d.rotation.y += .002; }); renderer.render(scene,camera); }; loop();
}
function resize() { if (!renderer || !camera) return; const w = Math.max(1,stage.clientWidth), h = Math.max(1,stage.clientHeight); renderer.setSize(w,h,false); camera.aspect = w/h; camera.updateProjectionMatrix(); }
function clearDice() { diceMeshes.forEach(mesh => { scene.remove(mesh); mesh.geometry.dispose(); if (Array.isArray(mesh.material)) mesh.material.forEach(m=>{m.map?.dispose();m.dispose();}); }); diceMeshes=[]; }
function secureRandom(max) { const arr = new Uint32Array(1); crypto.getRandomValues(arr); return (arr[0] % max) + 1; }
function createDice(sides, count) {
  clearDice();
  for (let i=0;i<count;i++) {
    const geometry = geometryFor(sides), mesh = new THREE.Mesh(geometry, makeFaceMaterials(sides)); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set((i-(count-1)/2)*1.55, .2 + Math.random()*.5, 0); mesh.rotation.set(Math.random()*3,Math.random()*3,Math.random()*3);
    scene.add(mesh); diceMeshes.push(mesh);
  }
}
function animateRoll(sides, results) {
  return new Promise(resolve => {
    const from = diceMeshes.map(m => ({ x:m.rotation.x,y:m.rotation.y,z:m.rotation.z, px:m.position.x,py:m.position.y }));
    const duration = 1450, start = performance.now();
    const frame = now => {
      const t = Math.min(1,(now-start)/duration), ease = 1-Math.pow(1-t,4);
      diceMeshes.forEach((mesh,i) => {
        const a=from[i]; mesh.rotation.set(a.x + Math.PI*6*ease, a.y + Math.PI*7*ease, a.z + Math.PI*5*ease);
        mesh.position.y = .2 + Math.abs(Math.sin(t*Math.PI*5))*(1-t)*.8;
        if (t === 1) { mesh.rotation.set(0, (results[i]-1) * (Math.PI*2/sides), 0); mesh.position.y=.0; }
      });
      renderer.render(scene,camera);
      if (t<1) requestAnimationFrame(frame); else { rolling=false; resolve(); }
    }; requestAnimationFrame(frame);
  });
}
export function initDice() {
  initScene();
  document.getElementById("roll-dice").addEventListener("click", roll);
  document.getElementById("clear-dice-history").addEventListener("click", clearHistory);
  renderHistory();
}
async function roll() {
  if (rolling) return;
  const type=Number(document.getElementById("dice-type").value), quantity=Math.min(10,Math.max(1,Number(document.getElementById("dice-quantity").value)||1)), modifier=Math.max(-999,Math.min(999,Number(document.getElementById("dice-modifier").value)||0));
  const sides = type===100 ? 10 : type, count = type===100 ? 2 : quantity;
  const results = Array.from({length:count},()=>secureRandom(sides));
  if (type===100) results[0] = (results[0] % 10) * 10, results[1] = results[1] % 10;
  const percentile = type===100 ? results[0]+results[1] : null;
  const normalized = type===100 ? [percentile === 0 ? 100 : percentile] : results;
  const total = normalized.reduce((a,b)=>a+b,0)+modifier;
  rolling=true; document.getElementById("roll-dice").disabled=true;
  createDice(sides,count); await animateRoll(sides,results);
  document.getElementById("roll-dice").disabled=false;
  const totalEl=document.getElementById("dice-total"); totalEl.textContent=total;
  const individual=document.getElementById("dice-individual");
  individual.innerHTML="";
  normalized.forEach((n,i)=>{ const span=document.createElement("span"); span.textContent=`${i?", ":""}${n}`; if(type===20){if(n===20)span.className="max";if(n===1)span.className="min";} individual.append(span); });
  if(modifier) individual.append(document.createTextNode(` ${modifier>0?"+":""}${modifier}`));
  const entry={type:`d${type}`,quantity,modifier,results:normalized,total,at:new Date().toISOString()};
  state.diceHistory.unshift(entry); state.diceHistory=state.diceHistory.slice(0,10); saveLocalState(); renderHistory();
  insertDiceRoll(entry).catch(e=>{console.error(e);toast("Rolagem salva localmente; falha ao sincronizar.","error");});
}
export function renderDiceHistory() { renderHistory(); }
function renderHistory() {
  const list=document.getElementById("dice-history"); list.innerHTML="";
  if(!state.diceHistory.length){const li=document.createElement("li");li.className="empty-history";li.textContent="Nenhuma rolagem ainda.";list.append(li);return;}
  state.diceHistory.slice(0,10).forEach(r=>{const li=document.createElement("li");const left=document.createElement("span");left.textContent=`${r.type} · [${(r.results||[]).join(", ")}]`;const right=document.createElement("b");right.textContent=`${r.total>0?"+":""}${r.total}`;li.append(left,right);list.append(li);});
}
async function clearHistory() {
  if(!await confirmarModal({title:"Limpar histórico de dados?",message:"As últimas rolagens serão removidas permanentemente.",confirmText:"Limpar",danger:true}))return;
  state.diceHistory=[];saveLocalState();scheduleSync();renderHistory();toast("Histórico de dados limpo.");
}

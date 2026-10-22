/**
 * Genetic image relief. Small candidate populations evolve each block's color and brightness-based depth; instanced cubes display the result.
 */
import * as THREE from 'three';
import {OrbitControls} from '../../Lib/Three/OrbitControls.js';
import {createImageEvolutionAsync,evolveImageRange} from './evolution.mjs?v=1080-1';
const view=document.getElementById('image-view'),status=document.getElementById('image-status'),play=document.getElementById('play'),step=document.getElementById('step');
const preview=document.getElementById('source-preview'),sample=document.createElement('canvas');
const scene=new THREE.Scene();scene.background=new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--site-bg').trim());
const camera=new THREE.PerspectiveCamera(45,1,.1,1000);
let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true});}catch(error){const message=document.getElementById('scene-error');message.hidden=false;message.textContent='Please enable WebGL to view the 3D image.';throw error;}
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.domElement.setAttribute('aria-label','Evolving 3D block portrait');view.appendChild(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=15;controls.maxDistance=500;
scene.add(new THREE.HemisphereLight(0xffffff,0x607080,2));const light=new THREE.DirectionalLight(0xffffff,1.5);light.position.set(30,50,100);scene.add(light);
const geometry=new THREE.BoxGeometry(1,1,1),material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.8});
let source,state,mesh,cols=32,rows=32,running=false,last=0,accumulator=0,loadToken=0;
const tint=new THREE.Color();
let buildToken=0,evolutionCursor=0,stepPending=false;
const motion={time:{value:0},tile:{value:1},enabled:{value:1}};
material.onBeforeCompile=shader=>{
    shader.uniforms.motionTime=motion.time;shader.uniforms.motionTile=motion.tile;shader.uniforms.motionEnabled=motion.enabled;
    shader.vertexShader="attribute float blockPhase; uniform float motionTime; uniform float motionTile; uniform float motionEnabled;\n"+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace("#include <project_vertex>","#include <project_vertex>\n gl_Position += projectionMatrix * modelViewMatrix * vec4(0.0, sin(motionTime*1.25+blockPhase)*motionTile*.14*motionEnabled, sin(motionTime*.9+blockPhase)*.72*motionEnabled, 0.0);");
};
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
/**
 * Pause simulation playback and restore the controls without discarding the current state.
 *
 * Inputs: None; uses enclosing state where needed.
 * @returns No value is returned; updates the current state, scene, or interface.
 */
function stop(){running=false;stepPending=false;play.textContent='Start evolution';step.disabled=false;accumulator=0;}
/**
 * Frame the portrait front-on or at an angle, accounting for its aspect ratio.
 *
 * @param front - Whether to align the camera directly in front of the portrait. Default: false.
 * @returns No value is returned; updates the current state, scene, or interface.
 */
function frame(front=false){const h=80*rows/cols;controls.target.set(0,0,0);const distance=Math.max(80,h)/(2*Math.tan(Math.PI/8)) / Math.min(1,camera.aspect)*1.25;camera.position.set(front?0:distance*.3,front?0:distance*.15,distance);controls.update();}
/**
 * Update GPU motion uniforms; the shader animates all blocks without CPU matrix rewrites.
 *
 * @param time - Animation-frame timestamp in milliseconds.
 * @returns No value is returned; updates the current state, scene, or interface.
 */
function animateBlocks(time){motion.time.value=time/1000;motion.enabled.value=reducedMotion.matches?0:1;}
/**
 * Copy evolved colors and base transforms into a bounded GPU instance range.
 *
 * @param start - First included instance index; defaults to zero.
 * @param end - Exclusive instance limit; defaults to the current block count.
 * @returns No value; uploads the changed instance range and refreshes statistics.
 */
function updateMesh(start=0,end=state.count){
    const tile=80/cols,depth=Number(document.getElementById('depth').value),matrices=mesh.instanceMatrix.array,colors=mesh.instanceColor.array;
    for(let i=start;i<end;i++){
        const offset=i*4,height=.5+state.best[offset+3]*depth,m=i*16;
        matrices[m]=tile*.86;matrices[m+5]=tile*.86;matrices[m+10]=height;matrices[m+15]=1;
        matrices[m+12]=(i%cols-(cols-1)/2)*tile;matrices[m+13]=((rows-1)/2-Math.floor(i/cols))*tile;matrices[m+14]=height/2;
        tint.setRGB(state.best[offset],state.best[offset+1],state.best[offset+2],THREE.SRGBColorSpace);
        colors[i*3]=tint.r;colors[i*3+1]=tint.g;colors[i*3+2]=tint.b;
    }
    mesh.instanceMatrix.addUpdateRange(start*16,(end-start)*16);mesh.instanceColor.addUpdateRange(start*3,(end-start)*3);
    mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;
    document.getElementById('generation').textContent=state.generation;
    document.getElementById('fitness').textContent=`${((1-Math.sqrt(state.error))*100).toFixed(1)}%`;
}
/**
 * Resample the source image at the requested block resolution and create fresh candidate populations.
 *
 * Inputs: None; uses enclosing state where needed.
 * @returns Promise resolving when the batched portrait build finishes or is superseded.
 */
async function restart(){
    if(!source)return;stop();stepPending=false;step.disabled=true;play.disabled=true;
    const token=++buildToken;state=null;evolutionCursor=0;
    if(mesh){scene.remove(mesh);mesh.dispose();mesh=null;}
    const resolution=Number(document.getElementById('resolution').value),aspect=source.width/source.height;
    cols=Math.max(4,Math.round(resolution*Math.min(1,aspect)));rows=Math.max(4,Math.round(resolution*Math.min(1,1/aspect)));
    sample.width=cols;sample.height=rows;const ctx=sample.getContext('2d',{willReadFrequently:true});ctx.fillStyle='white';ctx.fillRect(0,0,cols,rows);ctx.drawImage(source,0,0,cols,rows);
    status.textContent=`Preparing ${cols} × ${rows} blocks…`;
    const candidate=await createImageEvolutionAsync(ctx.getImageData(0,0,cols,rows).data,()=>token!==buildToken);
    if(!candidate||token!==buildToken)return;
    state=candidate;motion.tile.value=80/cols;
    const phases=new Float32Array(state.count);for(let i=0;i<state.count;i++)phases[i]=(i%cols)*.57+Math.floor(i/cols)*.43;
    geometry.setAttribute('blockPhase',new THREE.InstancedBufferAttribute(phases,1));
    mesh=new THREE.InstancedMesh(geometry,material,state.count);mesh.count=0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(state.count*3),3).setUsage(THREE.DynamicDrawUsage);
    mesh.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,0,15),Math.hypot(80,80*rows/cols,60)/2+2);
    scene.add(mesh);frame();
    for(let start=0;start<state.count;start+=8192){
        if(token!==buildToken)return;
        const end=Math.min(start+8192,state.count);updateMesh(start,end);mesh.count=end;
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(token!==buildToken)return;
    step.disabled=false;play.disabled=false;status.textContent=`${cols} × ${rows} blocks ready. Start evolution.`;
}
/**
 * Draw a fitted source preview and begin a fresh evolution run.
 *
 * @param image - Decoded image or canvas used as the source portrait.
 * @param name - CSS custom-property name or display label used by this operation.
 * @returns Promise resolving when the source preview and new portrait build are ready.
 */
async function useSource(image,name){source=image;const ctx=preview.getContext('2d');ctx.clearRect(0,0,preview.width,preview.height);const scale=Math.min(preview.width/image.width,preview.height/image.height);ctx.drawImage(image,(preview.width-image.width*scale)/2,(preview.height-image.height*scale)/2,image.width*scale,image.height*scale);await restart();}
/**
 * Decode an image asynchronously; a request token prevents older loads from replacing newer choices.
 *
 * @param url - Image URL or temporary browser object URL to decode.
 * @param name - CSS custom-property name or display label used by this operation.
 * @returns Promise that resolves when the operation completes; no result value is produced.
 */
async function loadImage(url,name){
    const token=++loadToken;status.textContent='Loading image…';
    try{const image=new Image();image.src=url;await image.decode();if(token!==loadToken)return;await useSource(image,name);}
    catch{if(token===loadToken)status.textContent='Unable to read this image. Choose another picture.';}
}
document.getElementById('upload-image').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    const url=URL.createObjectURL(file);try{await loadImage(url,file.name);}finally{URL.revokeObjectURL(url);}
});
/**
 * Populate the Oleg selector from the gallery endpoint and handle an unavailable gallery.
 *
 * Inputs: None; uses enclosing state where needed.
 * @returns Promise that resolves when the operation completes; no result value is produced.
 */
async function loadGallery(){
    const select=document.getElementById('oleg-photo'),button=document.getElementById('load-oleg');
    try{const response=await fetch('/oleg-images.php',{cache:'no-store'});if(!response.ok)throw Error();const {images}=await response.json();if(!Array.isArray(images)||!images.length)throw Error();select.replaceChildren();images.forEach((photo,i)=>{const option=document.createElement('option');option.value=photo.url;option.textContent=`Oleg — photo ${i+1}`;select.appendChild(option);});select.disabled=false;button.disabled=false;}
    catch{select.replaceChildren(new Option('Oleg photos unavailable',''));}
}
document.getElementById('load-oleg').addEventListener('click',()=>{const select=document.getElementById('oleg-photo');loadImage(select.value,select.selectedOptions[0].textContent);});
for(const id of ['resolution','mutation','depth'])document.getElementById(id).addEventListener('input',event=>{document.getElementById(`${id}-value`).value=event.target.value+(id==='mutation'?'%':'');if(id==='depth'&&state&&mesh)updateMesh();});
document.getElementById('resolution').addEventListener('change',restart);
/**
 * Evolve one bounded block batch and update only its 3D instances.
 *
 * Inputs: None; uses enclosing state where needed.
 * @returns No value is returned; updates the current state, scene, or interface.
 */
function advance(){
    if(!state||!mesh)return;
    const start=evolutionCursor,end=Math.min(start+2048,state.count);
    evolveImageRange(state,Number(document.getElementById('mutation').value)/100,start,end);
    evolutionCursor=end===state.count?0:end;
    if(evolutionCursor===0){state.generation++;if(stepPending){stepPending=false;step.disabled=false;}}
    updateMesh(start,end);
}
play.addEventListener('click',()=>{if(running){stop();return;}running=true;last=performance.now();play.textContent='Pause';step.disabled=true;});
step.addEventListener('click',()=>{stepPending=true;step.disabled=true;});document.getElementById('restart').addEventListener('click',restart);
document.getElementById('front-view').addEventListener('click',()=>frame(true));document.getElementById('orbit-view').addEventListener('click',()=>frame());
// Recalculate view dimensions when the surrounding layout changes.
new ResizeObserver(()=>{const w=Math.max(1,view.clientWidth),h=Math.max(1,view.clientHeight);renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}).observe(view);
// Keep visual frames separate from the simulation's own update timing.
renderer.setAnimationLoop(time=>{
    if(state&&mesh&&(running||stepPending)){
        accumulator+=Math.min((time-last)/1000,.1)*10;
        if(stepPending||state.count>2048||accumulator>=1){accumulator=0;advance();}
    }
    last=time;animateBlocks(time);controls.update();renderer.render(scene,camera);
});
const demo=document.createElement('canvas');demo.width=240;demo.height=180;const ctx=demo.getContext('2d');const gradient=ctx.createLinearGradient(0,0,0,180);gradient.addColorStop(0,'#548bc4');gradient.addColorStop(1,'#efbb80');ctx.fillStyle=gradient;ctx.fillRect(0,0,240,180);ctx.fillStyle='#ffe2a2';ctx.beginPath();ctx.arc(168,58,28,0,Math.PI*2);ctx.fill();ctx.fillStyle='#376f68';ctx.beginPath();ctx.moveTo(0,170);ctx.lineTo(85,60);ctx.lineTo(150,145);ctx.lineTo(197,100);ctx.lineTo(240,150);ctx.lineTo(240,180);ctx.lineTo(0,180);ctx.fill();useSource(demo,'Sample landscape');loadGallery();

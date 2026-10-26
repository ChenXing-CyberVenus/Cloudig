import * as THREE from "cloudig-three160";
import { GLTFLoader } from "cloudig-three160/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "cloudig-three160/examples/jsm/controls/OrbitControls.js";

/** File preview only, in the disposable work origin. A model does not carry
 * executable author scripts. Sidecars resolve only to files in this package. */
export async function renderGlb(root, file, input) {
  const urls = [], manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    const match = input.files.find(f => f.path === url || f.path === file.path.slice(0, file.path.lastIndexOf("/") + 1) + url);
    if (!match) throw new Error("The model references a file absent from this archive");
    const local = URL.createObjectURL(new Blob([match.bytes], { type: match.mime })); urls.push(local); return local;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(file.bytes, "");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.style.cssText = "height:100vh;min-height:240px;position:relative;overflow:hidden";
  root.append(renderer.domElement); renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, .01, 10000);
  scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0x546078, 2.5));
  const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(3, 5, 4); scene.add(key);
  const bounds = new THREE.Box3().setFromObject(gltf.scene), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 1;
  camera.near = radius / 1000; camera.far = radius * 100; camera.position.copy(center).add(new THREE.Vector3(radius * 1.3, radius * .8, radius * 1.8));
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(center); controls.enableDamping = true; controls.update();
  const resize = new ResizeObserver(() => { const w = root.clientWidth, h = root.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); }); resize.observe(root);
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(gltf.scene) : undefined;
  for (const clip of gltf.animations) mixer.clipAction(clip).play();
  const clock = new THREE.Clock(); let active = true, frame;
  const draw = () => { if (!active) return; mixer?.update(clock.getDelta()); controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(draw); }; draw();
  window.addEventListener("pagehide", () => {
    active = false; cancelAnimationFrame(frame); resize.disconnect(); controls.dispose(); mixer?.stopAllAction();
    gltf.scene.traverse(node => { node.geometry?.dispose(); for (const material of [].concat(node.material || [])) { for (const v of Object.values(material)) if (v?.isTexture) v.dispose(); material.dispose(); } });
    renderer.dispose(); renderer.forceContextLoss(); for (const url of urls) URL.revokeObjectURL(url);
  }, { once: true });
}

import { Map as MapLibreMap, Marker, Popup, NavigationControl, LngLatBounds, setWorkerUrl, setWorkerCount } from "./map-library.mjs";
import "maplibre-gl/dist/maplibre-gl.css";
import "./map-frame.css";
import { MAP_PROTOCOL, MAP_LIMITS, MAP_TILES_ORIGIN, validMapPoint, mapResourceUrl, type SavedMapPoint } from "./map-protocol.mts";

// This is trusted built-in UI, not an execution path for saved HTML/JS works.
const token = location.hash.slice(1), configuredParent = document.querySelector<HTMLMetaElement>('meta[name="cloudig-map-parent"]')!.content;
const publicSite = configuredParent === "same-origin", parentOrigin = publicSite ? location.origin : configuredParent;
const send = (kind: string, url?: string) => parent.postMessage({ protocol: MAP_PROTOCOL, token, kind, ...(url ? { url } : {}) }, parentOrigin);
let map: MapLibreMap | undefined, started = false;
const release = () => { map?.remove(); map = undefined; };
function mount(points: SavedMapPoint[], theme: "dawn" | "star-night", language: "zh" | "en") {
  document.documentElement.dataset["theme"] = theme; document.documentElement.lang = language;
  const nav = document.querySelector<HTMLElement>("#places")!; nav.setAttribute("aria-label", language === "en" ? "Places" : "地点");
  setWorkerCount(1); setWorkerUrl(new URL("./map-worker.js", location.href).href);
  map = new MapLibreMap({ container: "map", style: `${MAP_TILES_ORIGIN}/styles/${theme === "star-night" ? "dark" : "liberty"}`,
    center: [points[0]!.longitude, points[0]!.latitude], zoom: MAP_LIMITS.initialZoom, maxZoom: MAP_LIMITS.maximumZoom,
    transformRequest: url => ({ url: mapResourceUrl(url), credentials: "same-origin" }),
    attributionControl: { compact: false }, canvasContextAttributes: { preserveDrawingBuffer: false }
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  const bounds = new LngLatBounds();
  for (const [index, point] of points.entries()) {
    const detail = document.createElement("section"), title = document.createElement("strong"), notes = document.createElement("p");
    title.textContent = point.name; notes.textContent = point.notes; detail.append(title, notes);
    const marker = document.createElement("button"); marker.type = "button"; marker.className = "cloudig-map-marker"; marker.textContent = String(index + 1); marker.setAttribute("aria-label", point.name);
    const popup = new Popup({ offset: 24 }).setDOMContent(detail);
    new Marker({ element: marker }).setLngLat([point.longitude, point.latitude]).setPopup(popup).addTo(map);
    const choose = document.createElement("button"); choose.type = "button"; choose.textContent = `${index + 1} · ${point.name}`;
    choose.addEventListener("click", () => { if (!map) return; map.flyTo({ center: [point.longitude, point.latitude], zoom: Math.max(map.getZoom(), MAP_LIMITS.initialZoom), duration: 500 }); popup.setLngLat([point.longitude, point.latitude]).addTo(map); }); nav.append(choose);
    bounds.extend([point.longitude, point.latitude]);
  }
  if (points.length > 1) map.fitBounds(bounds, { padding: 64, maxZoom: MAP_LIMITS.initialZoom, duration: 0 });
  map.on("load", () => { document.documentElement.dataset["mapReady"] = "true"; send("loaded"); });
  map.on("error", () => {
    const error = document.querySelector<HTMLElement>("#map-error")!; error.hidden = false;
    error.textContent = language === "en" ? "Some map data could not be loaded. Check your connection or reload." : "部分地图数据无法加载，请检查网络或重新加载。";
    if (!map?.isStyleLoaded()) send("error");
  });
}
if (parentOrigin && (publicSite || parentOrigin !== location.origin) && /^https?:\/\//u.test(parentOrigin)) {
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || data?.protocol !== MAP_PROTOCOL || data?.token !== token) return;
    if (data.kind === "dispose") { release(); return; }
    if (data.kind !== "mount" || started) return;
    if (!Array.isArray(data.places) || !data.places.length || !data.places.every(validMapPoint)) { send("error"); return; }
    started = true;
    try { mount(data.places, data.theme === "star-night" ? "star-night" : "dawn", data.language === "en" ? "en" : "zh"); }
    catch { release(); send("error"); }
  });
  document.addEventListener("click", event => {
    const link = (event.target instanceof Element ? event.target : null)?.closest("a");
    if (link) { event.preventDefault(); send("external", link.href); }
  });
  window.addEventListener("pagehide", release, { once: true }); send("ready");
}

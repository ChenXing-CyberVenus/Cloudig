import { MAP_TILES_ORIGIN } from "./map-protocol.mts";

export type MapStyleLayer = { id: string; type: string; minzoom?: number; "source-layer"?: string; paint?: Record<string, unknown>; layout?: Record<string, unknown>; [key: string]: unknown };
export type MapStyle = { version: number; layers: MapStyleLayer[]; metadata?: Record<string, unknown>; [key: string]: unknown };
export const MAP_NIGHT_PALETTE = Object.freeze({
  land: "#293544", residential: "#2e3b4a", water: "#1f3d50", waterText: "#c0deeb",
  green: "#354e46", ice: "#677d8c", sand: "#635e4e", building: "#495462",
  road: "#455363", majorRoad: "#93846b", minorRoad: "#65717e", path: "#52685d",
  casing: "#26313f", rail: "#697181", ferry: "#54778a", boundary: "#647085",
  text: "#f0eee5", mutedText: "#d1dbe4", poi: "#ecebce", transit: "#d6ebff",
  hospital: "#4d3f4f", school: "#454b42"
});
export const MAP_NIGHT_HIERARCHY = Object.freeze({
  roadWidthScale: .65, minimumLabelSize: 12, textHaloWidth: 1.5, patternOpacityScale: .25
});
// Both themes must contain the same POIs, stations, labels and geographic
// layers. A reduced dark basemap is not an equivalent theme of Liberty.
export const mapStyleUrl = (_theme: "dawn" | "star-night"): string => `${MAP_TILES_ORIGIN}/styles/liberty`;

// Keep zoom expressions at the property root, as required by MapLibre. Scale
// only outputs, never zoom stops or geographic data. Unknown forms stay intact.
function scaleStops(value: unknown, factor: number): unknown {
  if (typeof value === "number") return value * factor;
  if (!Array.isArray(value)) return value;
  if (value[0] === "interpolate") return value.map((v, i) => i >= 4 && i % 2 === 0 ? scaleStops(v, factor) : v);
  if (value[0] === "step") return value.map((v, i) => i >= 2 && i % 2 === 0 ? scaleStops(v, factor) : v);
  return value;
}

function readableSize(value: unknown): unknown {
  if(typeof value==="number")return Math.max(MAP_NIGHT_HIERARCHY.minimumLabelSize,value);
  if(!Array.isArray(value))return value;
  if(value[0]==="interpolate")return value.map((v,i)=>i>=4&&i%2===0?readableSize(v):v);
  if(value[0]==="step")return value.map((v,i)=>i>=2&&i%2===0?readableSize(v):v);
  return value;
}

/** Shared cartography for GPT, Claude and future map consumers. Ground/water
 * stay coloured but quiet; minor roads recede, major roads orient, saved places
 * remain foreground. Preserve source geometry, filters, names and hidden layers.
 * Dawn stays provider-native; unfamiliar vector layers retain their base style. */
export function mapStyleForTheme(style: MapStyle, theme: "dawn" | "star-night"): MapStyle {
  if (theme !== "star-night") return style;
  const c=MAP_NIGHT_PALETTE,h=MAP_NIGHT_HIERARCHY;
  return {...style,metadata:{...style.metadata,"cloudig:palette":"star-night-complete-3"},layers:style.layers.map(layer=>{
    const source=layer["source-layer"],paint={...layer.paint},result:MapStyleLayer={...layer,paint};
    if(layer.type==="background")paint["background-color"]=c.land;
    if(layer.type==="fill") {
      if(source==="water")paint["fill-color"]=c.water;
      else if(source==="landuse")paint["fill-color"]=["match",["get","class"],"hospital",c.hospital,"school",c.school,["cemetery","pitch","track"],c.green,c.residential];
      else if(source==="park"){paint["fill-color"]=c.green;paint["fill-outline-color"]=c.green;paint["fill-opacity"]=.7;}
      else if(source==="landcover"){
        paint["fill-color"]=["case",["match",["get","subclass"],["ice_shelf","glacier"],true,false],c.ice,
          ["match",["get","class"],["ice","glacier"],c.ice,"sand",c.sand,c.green]];
        paint["fill-opacity"]=scaleStops(paint["fill-opacity"]??1,.7);
      }
      else if(source==="building"){
        paint["fill-color"]=c.building;
        paint["fill-outline-color"]=c.residential;
        paint["fill-opacity"]=["interpolate",["linear"],["zoom"],12,.15,16,.6];
      }
      else if(source==="transportation"||source==="aeroway")paint["fill-color"]=c.residential;
      if(layer.paint?.["fill-pattern"]){
        delete paint["fill-color"];
        paint["fill-opacity"]=scaleStops(paint["fill-opacity"]??1,h.patternOpacityScale);
      }
    }
    if(layer.type==="fill-extrusion"&&source==="building")paint["fill-extrusion-color"]=c.building;
    if(layer.type==="line"){
      if(source==="waterway")paint["line-color"]=c.water;
      else if(source==="park")paint["line-color"]=c.green;
      else if(source==="boundary")paint["line-color"]=c.boundary;
      else if(source==="transportation"||source==="aeroway"){
        paint["line-color"]=/(?:casing|outline)/u.test(layer.id)?c.casing:
          ["match",["get","class"],["motorway","trunk","primary"],c.majorRoad,["secondary","tertiary"],c.minorRoad,
            ["rail","transit"],c.rail,["path","pedestrian","track"],c.path,"ferry",c.ferry,"pier",c.residential,c.road];
        if(paint["line-width"]!==undefined)paint["line-width"]=scaleStops(paint["line-width"],h.roadWidthScale);
        if(paint["line-gap-width"]!==undefined)paint["line-gap-width"]=scaleStops(paint["line-gap-width"],h.roadWidthScale);
      }
    }
    if(layer.type==="symbol"&&layer.layout?.["text-field"]){
      // Route shields have their own raster background and matching text.
      // Recolouring their text like ordinary labels makes white-on-white signs.
      if(source==="transportation_name"&&layer.layout["icon-image"])return result;
      const water=source==="water_name"||source==="waterway";
      paint["text-color"]=water?c.waterText:source==="poi"||source==="aerodrome_label"?
        ["match",["get","class"],["railway","bus","airport"],c.transit,c.poi]:source==="place"?
        ["match",["get","class"],["continent","country","state","city","town"],c.text,c.mutedText]:c.mutedText;
      paint["text-halo-color"]=water?c.water:c.land;
      paint["text-halo-width"]=h.textHaloWidth;
      paint["text-halo-blur"]=.25;
      // Keep provider zoom/rank/collision rules; dark mode must not suppress
      // places that the light map displays. Improve legibility, not sparsity.
      result.layout={...layer.layout};
      if(layer.layout["text-size"]!==undefined)result.layout["text-size"]=readableSize(layer.layout["text-size"]);
    }
    return result;
  })};
}

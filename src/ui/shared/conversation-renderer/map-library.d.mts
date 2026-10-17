type Coordinate = [number, number];
export declare class Map {
  constructor(options: { container: string; style: string; center: Coordinate; zoom: number; maxZoom: number;
    transformRequest: (url: string) => { url: string; credentials: "same-origin" };
    attributionControl: { compact: boolean }; canvasContextAttributes: { preserveDrawingBuffer: boolean } });
  addControl(control: NavigationControl, position: string): this;
  fitBounds(bounds: LngLatBounds, options: { padding: number; maxZoom: number; duration: number }): this;
  flyTo(options: { center: Coordinate; zoom: number; duration: number }): this;
  getZoom(): number;
  isStyleLoaded(): boolean;
  on(event: "load" | "error", action: () => void): this;
  remove(): void;
}
export declare class Popup {
  constructor(options: { offset: number });
  setDOMContent(node: HTMLElement): this;
  setLngLat(point: Coordinate): this;
  addTo(map: Map): this;
}
export declare class Marker {
  constructor(options: { element: HTMLElement });
  setLngLat(point: Coordinate): this;
  setPopup(popup: Popup): this;
  addTo(map: Map): this;
}
export declare class NavigationControl { constructor(options: { showCompass: boolean }); }
export declare class LngLatBounds { extend(point: Coordinate): this; }
export declare function setWorkerUrl(url: string): void;
export declare function setWorkerCount(count: number): void;

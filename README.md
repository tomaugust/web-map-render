# web-map-render

A trial of what's possible: a 3D terrain map of **Cholsey, Oxfordshire**, cut to the real parish
boundary and raised using open elevation data. It floats on a white background and turns slowly.

- **Grab and turn** – drag to rotate and tilt (flick for momentum); scroll or pinch to zoom.
- **Pin** – a location pin sits at the centre of the parish; click or tap it for a popout.
- **Auto-rotate** – slow spin that pauses while the popout is open (off with `prefers-reduced-motion`).

## River flow tab

Switch to **River flow** (or open `#rain`) for a water-flow simulation on the same terrain. Move the mouse to
steer a rain cloud; drops fall and run downhill (shallow-water "virtual pipes" model on a 220-cell grid
built from the elevation data), pooling in hollows and draining off the parish edge. Drag to turn,
use the slider to change rainfall, and **Clear water** to reset. It runs as a time-lapse and is a
demo, not a hydrological model (coarse ~19 m elevation, no soil or drainage data). Rivers, streams, ditches,
ponds and lakes come from vector map data and are cut into the ground (so water runs into them, not over
them) and drawn as water; the Thames shows along the eastern edge. **Depths are generic assumptions**:
OpenStreetMap has no widths or depths, and no open dataset covers river or small-lake depth here (the UKCEH
UK Lakes Portal has outlines only, with depth recorded for almost none). Streams are 0.4-0.5 m deep, the river
about 3 m, and lakes 0.8-3.5 m by size, with shelving shores.

## Pollution tab

Switch to **Pollution** (or open `#smoke`). A model factory sits on the map (click anywhere to move it) and
emits smoke from its main stack. Controls: **wind speed** (0-20 m/s), **wind from** (compass bearing) and
**direction constancy** (100% = steady wind, a straight plume; low = the wind direction and gusts
wander, so the plume snakes and swings). The compass shows the set wind (faint) and the live wind (blue).
The smoke is a GPU particle simulation (about 147,000 particles, `?n=256` etc. in the URL changes the
count): hot smoke rises on buoyancy while entrainment cools and slows it, strong wind bends the plume
over, and a divergence-free curl-noise field adds swirling eddies that grow with the plume's age so it
billows further downwind. Puffs are drawn as soft, sun-lit sprites that lighten as they dilute. It
needs WebGL2 with float render targets (most desktop browsers). Shown as a x30 time-lapse; it is
illustrative, not a dispersion model.

## Wildfire tab

Switch to **Wildfire** (or open `#fire`) and tap the map to start a fire. It spreads through the green
spaces and struggles across everything else. The fuel map is built from vector map data (exact roads,
railway, water, buildings and land cover):
forest, grass, meadow and farmland burn well; gardens and bare land less; roads, railways, built-up
areas and water barely at all (fire only gets across by creeping through a thin line or by embers
thrown downwind, so it sometimes jumps a road and rarely a river). Spread is faster downwind and uphill,
and the **wind speed / direction** sliders change it. **Show what can burn** overlays the fuel map and
**Put out fire** resets. Burning cells drive two GPU particle systems (flames and a light plume of smoke,
the same mechanism as the Pollution tab) over a glowing fire front and charred ground. It is a time-lapse
cellular automaton for illustration, not a fire-behaviour model.

## Run

No build step. Serve the folder and open it (ES modules need http, not `file://`):

```
python3 -m http.server 8000   # then visit http://localhost:8000
```

three.js is loaded from jsDelivr, so an internet connection is needed (map tiles are fetched live too).

## Data

| Layer | Source |
| --- | --- |
| Parish boundary | OpenStreetMap relation 77791, saved as `data/cholsey-parish.geojson` (fetched via Nominatim) |
| Elevation | Mapzen/AWS Terrain Tiles (terrarium, z13), exaggerated 4x vertically |
| Imagery | OpenStreetMap raster tiles (z14), draped over the terrain (picture only) |
| Water, roads, rail, buildings, land cover | OpenStreetMap vector tiles via OpenFreeMap, saved as `data/vectors.geojson` (`npm install && npm run data:vectors` to refresh) |

Map data © OpenStreetMap contributors (ODbL). OSM's tile servers are for light use only; swap in
your own tile source before using this for anything real.

## Files

- `src/terrain.js` – fetches/stitches tiles, builds the displaced mesh clipped to the boundary, walls and base.
- `src/rain.js` – water simulation, cloud, raindrops and water overlay.
- `src/smoke.js` – factory model, wind model and smoke particles (Pollution tab).
- `src/gpuParticles.js` – reusable GPU particle system (emitters, buoyancy, curl-noise eddies, sprites) used by the Wildfire tab.
- `src/vectors.js` – loads the vector data and rasterises it (water depth map, water layer, per-class coverage).
- `scripts/fetch-vectors.mjs` – downloads the vector tiles for the parish into `data/vectors.geojson`.
- `src/fire.js` – fuel map from the vector data (colour-guessing fallback), fire-spread model, overlays, flames and smoke.
- `src/pick.js` – pointer-to-terrain picking shared by the Rain and Smoke tabs.
- `src/main.js` – scene, tabs, lighting, pin, drag/zoom controls, popout.
- `src/geo.js` – Web Mercator helpers.

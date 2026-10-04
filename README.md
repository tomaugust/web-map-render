# web-map-render

A trial of what's possible: a 3D terrain map of **Cholsey, Oxfordshire**, cut to the real parish
boundary and raised using open elevation data. It floats on a white background and turns slowly.

- **Grab and turn** – drag to rotate and tilt (flick for momentum); scroll or pinch to zoom.
- **Pin** – a location pin sits at the centre of the parish; click or tap it for a popout.
- **Auto-rotate** – slow spin that pauses while the popout is open (off with `prefers-reduced-motion`).

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
| Imagery | OpenStreetMap raster tiles (z14), draped over the terrain |

Map data © OpenStreetMap contributors (ODbL). OSM's tile servers are for light use only; swap in
your own tile source before using this for anything real.

## Files

- `src/terrain.js` – fetches/stitches tiles, builds the displaced mesh clipped to the boundary, walls and base.
- `src/main.js` – scene, lighting, pin, drag/zoom controls, popout.
- `src/geo.js` – Web Mercator helpers.

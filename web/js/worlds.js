// The worlds a model can be made of: Earth, the Moon, Mars and Venus. A world knows its size (the
// metres of ground in a degree), how its map is tiled, which layers the map shows, and where a
// capture takes its heights and its picture.
//
// Plain data: the map, the capture and the tests all read it.

import { metresPerDegree } from './geo.js';

export const WORLDS = {
  earth: {
    id: 'earth',
    label: 'Earth',
    inSentence: 'Earth',            // as the name stands in a sentence: "on Earth", "on the Moon"
    radiusM: 6378137,               // the sphere of Web Mercator: the map's metres and the model's agree
    grid: 'mercator',
    maxZoom: 19,
    hasSea: true,
    map: { layer: 'earth-photo', maxNativeZoom: 19, labels: 'earth-labels' },
    // Maps of the world on other sites, listed on the main page (atlas-links.js): for Earth, the
    // ordinary Google Maps.
    atlases: [
      { label: 'Google Maps', url: 'https://www.google.com/maps', hint: 'The ordinary Google Maps' },
    ],
    // Heights: Copernicus DEM 30 m read by the server from AWS Open Data (no key; 90 m where 30 m is not
    // released); AWS Terrain Tiles (no key, read here from map tiles); or Copernicus through
    // OpenTopography, with its key.
    heights: [
      // the same model twice, from two places: the name says the difference, the user chooses
      { id: 'cop-aws', label: 'Copernicus 30 m: open files on AWS, no key', server: '/api/earth/heights', query: { source: 'aws' } },
      { id: 'aws', label: 'AWS Terrain (no key)', tiles: 'earth-heights', maxZoom: 15 },
      { id: 'copernicus', label: 'Copernicus 30 m: the OpenTopography service, key needed', server: '/api/earth/heights' },
    ],
    // Each picture is shown on the map too, so that the map looks like the picture the model gets.
    pictures: [
      // Past 17 Esri often answers with a grey "no data yet" picture instead of a 404.
      { id: 'photo', label: 'Esri World Imagery', tiles: 'earth-photo', maxZoom: 17, map: { layer: 'earth-photo', maxNativeZoom: 19 } },
      // Sentinel-2's own cells are 10 m: past zoom 14 its tiles are only enlarged. The newest mosaic.
      { id: 's2', label: 'Sentinel-2 cloudless 2025', tiles: 'earth-s2-2025', maxZoom: 14, map: { layer: 'earth-s2-2025', maxNativeZoom: 15 } },
      // Aerial photos of the USA only, about 1 m: elsewhere the map is empty.
      { id: 'usgs', label: 'USGS aerial photos (the USA only), about 1 m', tiles: 'earth-usgs', maxZoom: 16, map: { layer: 'earth-usgs', maxNativeZoom: 16 } },
    ],
    names: 'nominatim',
    start: { lat: 43.3499, lon: 42.4453, zoom: 11 },          // Elbrus
  },
  moon: {
    id: 'moon',
    label: 'Moon',
    inSentence: 'the Moon',
    radiusM: 1737400,               // the sphere the lunar heights are measured from
    grid: 'lonlat',
    maxZoom: 12,
    hasSea: false,
    map: { layer: 'moon-wac', maxNativeZoom: 8, detail: { layer: 'moon-kaguya', minZoom: 9, maxNativeZoom: 10 } },
    heights: [
      { id: 'trek', label: 'SLDEM2015 59 m or LOLA 118 m', server: '/api/planet/heights',
        hint: 'SLDEM2015 59 m for places up to about 25 km between 60° S and 60° N, LRO LOLA 118 m elsewhere' },
      { id: 'lola', label: 'LOLA 118 m only', server: '/api/planet/heights', query: { source: 'trek' } },
    ],
    // By the place's size (the first choice): Kaguya (21 m) up to about 170 km, stitched from its
    // tiles; WAC (100 m) beyond.
    autoPicture: { label: 'Kaguya or WAC, by the size', hint: 'Kaguya 21 m for places up to 170 km across, LRO WAC 100 m beyond' },
    pictures: [
      { id: 'kaguya', label: 'Kaguya TC mosaic, 21 m', tiles: 'moon-kaguya', maxZoom: 10, upToKm: 170 },
      { id: 'wac', label: 'LRO WAC mosaic, about 100 m', server: '/api/planet/image', nativeM: 100, map: { layer: 'moon-wac', maxNativeZoom: 8 } },
    ],
    names: 'data/moon-names.json',
    start: { lat: 0.674, lon: 23.473, zoom: 8 },              // Tranquility Base, Apollo 11
    // Craft on the surface (map-screen.js): where each landed, the newest determinations; those the
    // IAU named a station of (USGS: Statio Tranquillitatis, Guang Han Gong, Statio Tianhe, Tianchuan,
    // Shiv Shakti, Tianjiang) at the station's point. A pick shows about viewKm round it.
    landers: {
      viewKm: 6,
      list: [
        { label: 'Luna 9', year: 1966, lat: 7.133, lon: -64.367 },
        { label: 'Surveyor 1', year: 1966, lat: -2.467, lon: -43.333 },
        { label: 'Surveyor 3', year: 1967, lat: -3.028, lon: -23.458 },
        { label: 'Surveyor 5', year: 1967, lat: 1.467, lon: 23.2 },
        { label: 'Surveyor 6', year: 1967, lat: 0.483, lon: -1.4 },
        { label: 'Surveyor 7', year: 1968, lat: -40.867, lon: -11.467 },
        { label: 'Apollo 11', year: 1969, lat: 0.6741, lon: 23.4732 },
        { label: 'Apollo 12', year: 1969, lat: -3.0125, lon: -23.4217 },
        { label: 'Luna 16', year: 1970, lat: -0.683, lon: 56.3 },
        { label: 'Luna 17 and Lunokhod 1', year: 1970, lat: 38.283, lon: -35.0 },
        { label: 'Apollo 14', year: 1971, lat: -3.6453, lon: -17.4714 },
        { label: 'Apollo 15', year: 1971, lat: 26.1322, lon: 3.6339 },
        { label: 'Luna 20', year: 1972, lat: 3.533, lon: 56.55 },
        { label: 'Apollo 16', year: 1972, lat: -8.973, lon: 15.5002 },
        { label: 'Apollo 17', year: 1972, lat: 20.1908, lon: 30.7717 },
        { label: 'Luna 21 and Lunokhod 2', year: 1973, lat: 25.85, lon: 30.45 },
        { label: 'Luna 24', year: 1976, lat: 12.75, lon: 62.2 },
        { label: "Chang'e 3 and Yutu", year: 2013, lat: 44.1184, lon: -19.5123 },
        { label: "Chang'e 4 and Yutu-2", year: 2019, lat: -45.45, lon: 177.6 },
        { label: "Chang'e 5", year: 2020, lat: 43.06, lon: -51.92 },
        { label: 'Chandrayaan-3: Vikram and Pragyan', year: 2023, lat: -69.3734, lon: 32.3198 },
        { label: 'SLIM', year: 2024, lat: -13.316, lon: 25.251 },
        { label: 'IM-1 Odysseus', year: 2024, lat: -80.133, lon: 1.433 },
        { label: "Chang'e 6", year: 2024, lat: -41.63, lon: -153.98 },
        { label: 'Blue Ghost 1', year: 2025, lat: 18.567, lon: 61.817 },
      ],
    },
    atlases: [
      { label: 'NASA Moon Trek', url: 'https://trek.nasa.gov/moon/', hint: 'NASA\'s map of the Moon: this app takes the Moon\'s pictures and heights from it' },
      { label: 'LROC QuickMap', url: 'https://quickmap.lroc.asu.edu/', hint: 'The finest pictures of the Moon, of the LRO cameras, with names' },
      { label: 'Google Moon', url: 'https://www.google.com/maps/space/moon/', hint: 'Google Maps in space: the Moon with its names' },
      { label: 'IAU names', url: 'https://planetarynames.wr.usgs.gov/Page/MOON/target', hint: 'The names this app\'s search finds (USGS): each with its place and size' },
    ],
  },
  mars: {
    id: 'mars',
    label: 'Mars',
    inSentence: 'Mars',
    radiusM: 3396190,               // the sphere of the Mars 2000 frame the heights use
    grid: 'lonlat',
    maxZoom: 13,                    // CTX's 5 m
    hasSea: false,
    map: { layer: 'mars-mdim', maxNativeZoom: 7 },
    heights: [{ id: 'trek', label: 'HRSC-MOLA blend, 200 m', server: '/api/planet/heights' }],
    pictures: [
      { id: 'mdim', label: 'Viking MDIM 2.1 colour, about 230 m', server: '/api/planet/image', nativeM: 230 },
      // THEMIS's daytime infrared: grey, but more than twice as fine as Viking's colour.
      { id: 'themis', label: 'THEMIS, 100 m, grey', tiles: 'mars-themis', maxZoom: 9, map: { layer: 'mars-themis', maxNativeZoom: 9 },
        hint: 'Mars Odyssey THEMIS: the ground in daytime infrared, 100 m, without colour' },
      // CTX's tiles are of 512 points: its level L is the zoom L + 1 of 256-point tiles (maxZoom here).
      { id: 'ctx', label: 'CTX, about 5 m, grey', tiles: 'mars-ctx', tilePx: 512, maxZoom: 13,
        map: { layer: 'mars-ctx', maxNativeZoom: 13, tileSize: 512, zoomOffset: -1 },
        hint: 'Mars Reconnaissance Orbiter CTX: the global mosaic of the Murray Lab, about 5 m, without colour' },
    ],
    names: 'data/mars-names.json',
    start: { lat: 18.65, lon: -133.8, zoom: 5 },              // Olympus Mons
    landers: {
      viewKm: 15,
      list: [
        { label: 'Viking 1', year: 1976, lat: 22.697, lon: -48.222 },
        { label: 'Viking 2', year: 1976, lat: 48.269, lon: 134.01 },
        { label: 'Mars Pathfinder and Sojourner', year: 1997, lat: 19.133, lon: -33.217 },
        { label: 'Beagle 2', year: 2003, lat: 11.526, lon: 90.429 },
        { label: 'Spirit', year: 2004, lat: -14.572, lon: 175.479 },
        { label: 'Opportunity', year: 2004, lat: -1.946, lon: -5.527 },
        { label: 'Phoenix', year: 2008, lat: 68.219, lon: -125.749 },
        { label: 'Curiosity', year: 2012, lat: -4.589, lon: 137.442 },
        { label: 'InSight', year: 2018, lat: 4.5024, lon: 135.6234 },
        { label: 'Perseverance and Ingenuity', year: 2021, lat: 18.445, lon: 77.451 },
        { label: 'Zhurong', year: 2021, lat: 25.066, lon: 109.925 },
      ],
    },
    atlases: [
      { label: 'NASA Mars Trek', url: 'https://trek.nasa.gov/mars/', hint: 'NASA\'s map of Mars: this app takes the heights of Mars from it' },
      { label: 'Mars QuickMap', url: 'https://mars.quickmap.io/', hint: 'Detailed pictures of Mars, with names' },
      { label: 'CTX mosaic (Murray Lab)', url: 'https://murray-lab.caltech.edu/CTX/V01/SceneView/', hint: 'The 5 m picture of the whole planet: the “CTX” picture of this app' },
      { label: 'Google Mars', url: 'https://www.google.com/maps/space/mars/', hint: 'Google Maps in space: Mars with its names' },
      { label: 'IAU names', url: 'https://planetarynames.wr.usgs.gov/Page/MARS/target', hint: 'The names this app\'s search finds (USGS): each with its place and size' },
    ],
  },
  venus: {
    id: 'venus',
    label: 'Venus',
    inSentence: 'Venus',
    radiusM: 6051800,               // the sphere of the Venus 2000 frame
    grid: 'lonlat',
    maxZoom: 11,
    hasSea: false,
    // Clouds hide the ground: what there is to see is Magellan's radar, bright where the ground is
    // rough. C3-MDIR (2 km) covers the planet; the left-look SAR mosaic (75 m) is finer, with gaps.
    map: { layer: 'venus-c3', maxNativeZoom: 5, detail: { layer: 'venus-sar', minZoom: 6, maxNativeZoom: 10 } },
    // One height cell is 4.6 km: only mountains, craters and coronae of 50 km and more have a shape.
    heights: [{ id: 'trek', label: 'Magellan topography, 4.6 km', server: '/api/planet/heights' }],
    pictures: [
      { id: 'sar', label: 'Radar, 75 m, with gaps', tiles: 'venus-sar', maxZoom: 10, hint: 'Magellan\'s radar mosaic, 75 m: a few strips are missing' },
      { id: 'c3', label: 'Radar, 2 km, no gaps', tiles: 'venus-c3', maxZoom: 5, map: { layer: 'venus-c3', maxNativeZoom: 5 },
        hint: 'Magellan\'s C3-MDIR radar mosaic, 2 km, the whole planet' },
    ],
    names: 'data/venus-names.json',
    start: { lat: 0.5, lon: -165.4, zoom: 5 },                // Maat Mons
    // The Venera and Vega landers' places are known to about a degree: the view is wide.
    landers: {
      viewKm: 300,
      list: [
        { label: 'Venera 7', year: 1970, lat: -5, lon: -9 },
        { label: 'Venera 8', year: 1972, lat: -10.7, lon: -24.75 },
        { label: 'Venera 9', year: 1975, lat: 31.017, lon: -68.367 },
        { label: 'Venera 10', year: 1975, lat: 15.417, lon: -68.483 },
        { label: 'Venera 11', year: 1978, lat: -14, lon: -61 },
        { label: 'Venera 12', year: 1978, lat: -7, lon: -66 },
        { label: 'Venera 13', year: 1982, lat: -7.5, lon: -57 },
        { label: 'Venera 14', year: 1982, lat: -13.25, lon: -50 },
        { label: 'Vega 1', year: 1985, lat: 7.2, lon: 177.8 },
        { label: 'Vega 2', year: 1985, lat: -7.133, lon: 177.667 },
      ],
    },
    atlases: [
      { label: 'NASA Venus Trek', url: 'https://trek.nasa.gov/venus/', hint: 'NASA\'s map of Venus: this app takes Magellan\'s radar pictures and heights from it' },
      { label: 'Google Venus', url: 'https://www.google.com/maps/space/venus/', hint: 'Google Maps in space: Venus with its names' },
      { label: 'IAU names', url: 'https://planetarynames.wr.usgs.gov/Page/VENUS/target', hint: 'The names this app\'s search finds (USGS): each with its place and size' },
    ],
  },
};

export const WORLD_ORDER = ['earth', 'moon', 'mars', 'venus'];

// The pictures to choose from on the map: with `autoPicture`, first the choice by the place's size
// (id 'auto', which no source has: pictureSourceFor picks then), then each source.
export function pictureOptions(world) {
  return world.autoPicture ? [{ id: 'auto', ...world.autoPicture }, ...world.pictures] : world.pictures;
}

// The world with this id; a missing one is Earth, an unknown one is refused.
export function worldOf(id) {
  const world = WORLDS[id ?? 'earth'];
  if (!world) throw new RangeError(`Unknown world: ${id}`);
  return world;
}

export function mPerDegOf(world) {
  return metresPerDegree(world.radiusM);
}

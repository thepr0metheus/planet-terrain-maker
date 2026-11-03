//! The tiled layers the page shows and captures.

/// How the tiles of a layer cover the world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileGrid {
    /// Web Mercator: 2^z x 2^z tiles.
    Mercator,
    /// Plain degrees, as Trek serves: 2^(z+1) x 2^z tiles.
    LonLat,
}

/// The kinds of picture a layer's tiles are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileKind {
    /// JPEG.
    Jpg,
    /// PNG.
    Png,
}

impl TileKind {
    /// The ending of the file a tile is kept in.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpg => "jpg",
            Self::Png => "png",
        }
    }

    /// The type of content.
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Jpg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
}

/// One tiled layer of one world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileSource {
    /// Its name in the address the page asks.
    pub id: &'static str,
    /// Its service's address, with `{z}`, `{x}` and `{y}`.
    pub url: String,
    /// The kind of its tiles.
    pub kind: TileKind,
    /// The last zoom it has.
    pub max_zoom: u64,
    /// How its tiles cover the world.
    pub grid: TileGrid,
    /// Fetches from the service at a time, at most.
    pub at_once: usize,
}

impl TileSource {
    const AT_ONCE: usize = 12;
    /// EOX resets a burst of a dozen connections at once (Errno 104 in the server's log): six.
    const AT_ONCE_EOX: usize = 6;

    /// Whether (z, x, y) names a tile of this layer at all.
    pub fn has(&self, z: u64, x: u64, y: u64) -> bool {
        if z > self.max_zoom {
            return false;
        }
        let columns = match self.grid {
            TileGrid::LonLat => 2_u64 << z,
            TileGrid::Mercator => 1_u64 << z,
        };
        x < columns && y < 1_u64 << z
    }

    /// The tile's address at its service.
    pub fn url_of(&self, z: u64, x: u64, y: u64) -> String {
        self.url.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string())
    }

    fn mercator(id: &'static str, url: &str, kind: TileKind, max_zoom: u64, at_once: usize) -> Self {
        Self { id, url: url.to_string(), kind, max_zoom, grid: TileGrid::Mercator, at_once }
    }

    fn trek(id: &'static str, body: &str, layer: &str, kind: TileKind, max_zoom: u64) -> Self {
        let url = format!(
            "https://trek.nasa.gov/tiles/{body}/EQ/{layer}/1.0.0/default/default028mm/{{z}}/{{y}}/{{x}}.{}",
            kind.extension()
        );
        Self { id, url, kind, max_zoom, grid: TileGrid::LonLat, at_once: Self::AT_ONCE }
    }

    /// Every layer. Sentinel-2 by EOX is CC BY-NC-SA 4.0, for non-commercial use; the USGS photos cover the USA only.
    /// The CTX mosaic of Mars has tiles of 512 points in plain degrees: its level L is as fine as the 256-point zoom
    /// L + 1 of the other layers.
    pub fn all() -> Vec<Self> {
        use TileKind::{Jpg, Png};
        vec![
            Self::mercator(
                "earth-photo",
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                Jpg,
                19,
                Self::AT_ONCE,
            ),
            Self::mercator(
                "earth-s2-2025",
                "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
                Jpg,
                15,
                Self::AT_ONCE_EOX,
            ),
            Self::mercator(
                "earth-usgs",
                "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
                Jpg,
                16,
                Self::AT_ONCE,
            ),
            Self::mercator(
                "earth-labels",
                "https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
                Png,
                19,
                Self::AT_ONCE,
            ),
            Self::mercator(
                "earth-heights",
                "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
                Png,
                15,
                Self::AT_ONCE,
            ),
            Self::trek("moon-wac", "Moon", "LRO_WAC_Mosaic_Global_303ppd_v02", Jpg, 8),
            Self::trek("moon-kaguya", "Moon", "Kaguya_TCortho_Mosaic_Global_4096ppd", Png, 10),
            Self::trek("mars-mdim", "Mars", "Mars_Viking_MDIM21_ClrMosaic_global_232m", Jpg, 7),
            Self::trek("mars-themis", "Mars", "THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018", Png, 9),
            Self {
                id: "mars-ctx",
                url: "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}".to_string(),
                kind: Png,
                max_zoom: 12,
                grid: TileGrid::LonLat,
                at_once: Self::AT_ONCE,
            },
            Self::trek("venus-c3", "Venus", "Venus_Magellan_C3-MDIR_Global_Mosaic_2025m", Png, 5),
            Self::trek("venus-sar", "Venus", "Venus_Magellan_LeftLook_mosaic_global_75m", Png, 10),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(id: &str) -> TileSource {
        TileSource::all().into_iter().find(|source| source.id == id).unwrap()
    }

    #[test]
    fn which_tiles_a_layer_has() {
        let (earth, moon) = (named("earth-photo"), named("moon-wac"));
        assert!(earth.has(2, 3, 3));
        assert!(!earth.has(2, 4, 0));
        assert!(moon.has(2, 7, 3), "plain degrees: twice as many columns as rows");
        assert!(!moon.has(2, 8, 0));
        assert!(!earth.has(20, 0, 0));
        assert!(!earth.has(u64::MAX, 0, 0));
        assert!(!earth.has(0, u64::MAX, 0));
    }

    #[test]
    fn the_order_in_an_address_is_the_layer_s_own() {
        assert!(named("earth-heights").url_of(3, 5, 2).ends_with("/3/5/2.png"), "terrarium is z/x/y");
        assert!(named("earth-photo").url_of(3, 5, 2).ends_with("/3/2/5"), "Esri is z/y/x");
    }

    #[test]
    fn the_names_are_not_taken_twice() {
        let mut names: Vec<&str> = TileSource::all().iter().map(|source| source.id).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), TileSource::all().len());
    }
}

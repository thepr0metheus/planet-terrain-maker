//! Heights and imagery of a region on the Moon, Mars or Venus, from NASA's Trek services.
//!
//! Trek's ArcGIS image servers answer one request per region (exportImage): the heights as raw numbers, the imagery
//! as a JPEG of exactly the region. No key and no special header are needed. Checked on 2026-10-05 against known
//! heights: Tranquility Base (Apollo 11) reads -1927.5 m on the Moon, the Olympus Mons summit point about 20 km on
//! Mars, Maxwell Montes 10.7 km and Maat Mons 9.0 km on Venus.
//!
//! Venus has no one-picture imagery service on Trek: its Magellan radar mosaics come only as map tiles, which the page
//! stitches for a capture. The Moon's finest imagery (Kaguya) is stitched from tiles too.
//!
//! All bodies are laid out in plain longitude and latitude (-180..180 east, the order Trek wants: a box given in 0..360
//! comes back all empty, with no error).

use crate::numbers::PyFloat;
use crate::percent::Percent;
use crate::refused::Refused;
use crate::region::Region;

/// The kind of number a height service answers in, little-endian.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pixel {
    /// float32.
    F32,
    /// int16.
    S16,
}

impl Pixel {
    fn name(self) -> &'static str {
        match self {
            Self::F32 => "F32",
            Self::S16 => "S16",
        }
    }

    fn width(self) -> usize {
        match self {
            Self::F32 => 4,
            Self::S16 => 2,
        }
    }

    fn read(self, bytes: &[u8]) -> Option<f64> {
        match self {
            Self::F32 => bytes.try_into().ok().map(|four| f64::from(f32::from_le_bytes(four))),
            Self::S16 => bytes.try_into().ok().map(|two| f64::from(i16::from_le_bytes(two))),
        }
    }
}

/// One body's height and imagery services.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Planet {
    /// Its name, in the addresses of Trek and in the words of the app.
    pub body: &'static str,
    heights_service: &'static str,
    pixel: Pixel,
    deg_per_px: f64,
    imagery_service: Option<&'static str>,
    /// The name the page shows for its heights.
    pub heights_name: &'static str,
    /// Whether a finer file of heights covers small regions (the Moon's SLDEM2015).
    pub has_finer_heights: bool,
}

impl Planet {
    /// What marks a cell without a height in Trek's answers.
    const NODATA: f64 = -32768.0;
    /// Cells a side at least. A 3 km crater is 30 cells of LOLA and 55 of SLDEM: as a mesh that is a few facets.
    /// Interpolated up to this, the bowl comes out smooth.
    pub const SMALLEST_GRID: usize = 96;

    /// Every body. Magellan's radar altimetry, gaps filled: one cell is 4.6 km, so only big regions (mountains and
    /// craters of 50 km and more) have a shape. The service sits in Trek's "venus" folder.
    pub const ALL: [Self; 3] = [
        Self {
            body: "moon",
            heights_service: "LRO_LOLA_DEM_Global_256ppd_v06",
            pixel: Pixel::F32,
            deg_per_px: 1.0 / 256.0,
            imagery_service: Some("LRO_WAC_Mosaic_Global_303ppd_v02"),
            heights_name: "LRO LOLA 118 m (NASA/GSFC)",
            has_finer_heights: true,
        },
        Self {
            body: "mars",
            heights_service: "Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw",
            pixel: Pixel::S16,
            deg_per_px: 0.00337412083064107,
            imagery_service: Some("Mars_Viking_MDIM21_ClrMosaic_global_232m"),
            heights_name: "HRSC-MOLA blend 200 m (ESA/DLR/FU Berlin, NASA)",
            has_finer_heights: false,
        },
        Self {
            body: "venus",
            heights_service: "venus/Venus_Magellan_Topography_Global_4641m_gapfilled_v02",
            pixel: Pixel::F32,
            deg_per_px: 0.0439453125,
            imagery_service: None,
            heights_name: "Magellan topography 4.6 km (NASA/JPL/USGS)",
            has_finer_heights: false,
        },
    ];

    /// The body of this name.
    pub fn named(world: &str) -> Option<&'static Self> {
        Self::ALL.iter().find(|planet| planet.body == world)
    }

    /// The names of the bodies, as a refusal lists them.
    pub fn names() -> String {
        Self::ALL.iter().map(|planet| planet.body).collect::<Vec<_>>().join(", ")
    }

    /// Cells (columns, rows) to ask for: the native size, at least `SMALLEST_GRID` and at most `max_cells` a side,
    /// keeping the shape of the region.
    pub fn heights_size(&self, region: &Region, max_cells: usize) -> (usize, usize) {
        let cols = (region.east - region.west) / self.deg_per_px;
        let rows = (region.north - region.south) / self.deg_per_px;
        let scale = if cols.max(rows) > max_cells as f64 {
            max_cells as f64 / cols.max(rows)
        } else if cols.min(rows) < Self::SMALLEST_GRID as f64 {
            Self::SMALLEST_GRID as f64 / cols.min(rows)
        } else {
            1.0
        };
        let cells = |side: f64| PyFloat::round_whole(side * scale).max(2) as usize;
        (cells(cols), cells(rows))
    }

    /// The address that asks for the heights of a region.
    pub fn heights_url(&self, region: &Region, size: (usize, usize)) -> String {
        self.export_url(
            self.heights_service,
            region,
            size,
            &[
                ("format", "bsq".to_string()),
                ("pixelType", self.pixel.name().to_string()),
                ("noData", (Self::NODATA as i64).to_string()),
                ("interpolation", "RSP_BilinearInterpolation".to_string()),
            ],
        )
    }

    /// The address that asks for a picture of a region; refused for a body whose imagery comes only as tiles.
    pub fn image_url(&self, region: &Region, size: (usize, usize)) -> Result<String, Refused> {
        let Some(service) = self.imagery_service else {
            let body = self.body;
            return Err(Refused::new(format!("{body} has no one-picture imagery: its map tiles are stitched instead")));
        };
        Ok(self.export_url(service, region, size, &[("format", "jpg".to_string())]))
    }

    fn export_url(&self, service: &str, region: &Region, size: (usize, usize), extra: &[(&str, String)]) -> String {
        let Region { south, north, west, east } = *region;
        let corners = [west, south, east, north].iter().map(|edge| PyFloat::repr(*edge)).collect::<Vec<_>>().join(",");
        let mut query = vec![("bbox", corners), ("size", format!("{},{}", size.0, size.1)), ("f", "image".to_string())];
        query.extend_from_slice(extra);
        format!(
            "https://trek.nasa.gov/{}/trekarcgis/rest/services/{service}/ImageServer/exportImage?{}",
            self.body,
            Percent::form(&query)
        )
    }

    /// The heights in metres, row by row from the north, NaN where there is no data. The answer is the raw grid, then a
    /// validity mask this ignores: a missing cell already reads `NODATA`.
    pub fn parse_heights(&self, data: &[u8], size: (usize, usize)) -> Result<Vec<f32>, Refused> {
        let (cols, rows) = size;
        let count = cols * rows;
        let width = self.pixel.width();
        let cells = data.get(..count * width).ok_or_else(|| {
            let (wanted, got) = (count * width, data.len());
            Refused::new(format!("expected {wanted} bytes of heights for {cols}x{rows}, got {got}"))
        })?;
        Ok(cells.chunks_exact(width).map(|bytes| self.height_of(bytes)).collect())
    }

    fn height_of(&self, bytes: &[u8]) -> f32 {
        match self.pixel.read(bytes) {
            Some(value) if value != Self::NODATA && !value.is_nan() && value.abs() <= 1e6 => value as f32,
            _ => f32::NAN,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLACE: Region = Region { south: 0.0, north: 1.0, west: 0.0, east: 1.0 };

    #[test]
    fn the_size_keeps_the_shape_within_its_limits() {
        let moon = Planet::named("moon").unwrap();
        assert_eq!(moon.heights_size(&PLACE, 64), (64, 64));
        let mars = Planet::named("mars").unwrap();
        let long = Region { south: 10.0, north: 10.1, west: 20.0, east: 20.5 };
        assert_eq!(mars.heights_size(&long, 1024), (480, 96));
        let wide = Region { south: 0.0, north: 10.0, west: 0.0, east: 40.0 };
        assert_eq!(mars.heights_size(&wide, 512), (512, 128));
    }

    #[test]
    fn what_is_asked_of_trek() {
        let moon = Planet::named("moon").unwrap();
        let place = Region { south: -0.5, north: 0.25, west: 23.5, east: 24.75 };
        assert_eq!(
            moon.heights_url(&place, (320, 192)),
            "https://trek.nasa.gov/moon/trekarcgis/rest/services/LRO_LOLA_DEM_Global_256ppd_v06/ImageServer/exportImage\
             ?bbox=23.5%2C-0.5%2C24.75%2C0.25&size=320%2C192&f=image&format=bsq&pixelType=F32&noData=-32768\
             &interpolation=RSP_BilinearInterpolation"
        );
        assert!(Planet::named("venus").unwrap().image_url(&PLACE, (9, 9)).is_err());
        assert!(moon.image_url(&PLACE, (9, 9)).unwrap().ends_with("&format=jpg"));
    }

    #[test]
    fn heights_are_read_with_no_data() {
        let moon = Planet::named("moon").unwrap();
        let body: Vec<u8> =
            [100.0_f32, -32768.0, 2.5, f32::NAN, 2e6].iter().flat_map(|value| value.to_le_bytes()).collect();
        let parsed = moon.parse_heights(&[body, b"mask".to_vec()].concat(), (5, 1)).unwrap();
        assert_eq!(parsed[0], 100.0);
        assert_eq!(parsed[2], 2.5);
        assert!(parsed[1].is_nan() && parsed[3].is_nan() && parsed[4].is_nan());
        assert!(moon.parse_heights(&[0; 16], (5, 1)).unwrap_err().0.contains("bytes of heights"));
        let mars = Planet::named("mars").unwrap();
        let shorts: Vec<u8> = [-1000_i16, -32768].iter().flat_map(|value| value.to_le_bytes()).collect();
        let parsed = mars.parse_heights(&shorts, (2, 1)).unwrap();
        assert_eq!(parsed[0], -1000.0);
        assert!(parsed[1].is_nan());
    }
}

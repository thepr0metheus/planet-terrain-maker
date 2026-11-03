//! Copernicus DEM heights straight from AWS Open Data: which files a region needs, and where its cells fall in them.
//!
//! The 30 m model (GLO-30) lies on S3 as one Cloud Optimized GeoTIFF a degree of latitude and longitude. Where the 30 m
//! model is not released (a few countries), the 90 m one (GLO-90) answers; a degree with no file at all is open sea:
//! 0 m. Files are pixel-is-point: pixel (0, 0) of N43_00_E042_00 is the point 44° N, 42° E, and the file covers latitudes
//! above 43 and up to 44, longitudes from 42 up to 43. Away from the equator the files are narrower east-west (2400
//! pixels from 50°, 1800 from 60° and so on): each file says so.

use crate::numbers::PyFloat;
use crate::region::Region;

/// One of the two models on AWS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CopernicusModel {
    base: &'static str,
    code: &'static str,
    /// Its name, as the page shows it.
    pub name: &'static str,
}

impl CopernicusModel {
    /// The finer first: it answers where it is released.
    pub const ALL: [Self; 2] = [
        Self {
            base: "https://copernicus-dem-30m.s3.amazonaws.com",
            code: "10",
            name: "Copernicus DEM GLO-30 (ESA), AWS Open Data",
        },
        Self {
            base: "https://copernicus-dem-90m.s3.amazonaws.com",
            code: "30",
            name: "Copernicus DEM GLO-90 (ESA), AWS Open Data",
        },
    ];

    /// The source of a grid where no file answered.
    pub const OPEN_SEA: &'static str = "Copernicus DEM (ESA), AWS Open Data: open sea";

    /// The name of the file of the degree with this south-west corner.
    pub fn file_name(&self, lat: i32, lon: i32) -> String {
        let ns = if lat >= 0 { 'N' } else { 'S' };
        let ew = if lon >= 0 { 'E' } else { 'W' };
        format!("Copernicus_DSM_COG_{}_{ns}{:02}_00_{ew}{:03}_00_DEM", self.code, lat.abs(), lon.abs())
    }

    /// The address of the file of that degree.
    pub fn url(&self, lat: i32, lon: i32) -> String {
        let name = self.file_name(lat, lon);
        format!("{}/{name}/{name}.tif", self.base)
    }
}

/// The cells of a grid of a region, and where each lies.
#[derive(Debug, Clone, PartialEq)]
pub struct CopernicusPlan {
    /// Degrees of latitude a cell may cover at most.
    pub want: f64,
    /// The latitude of each row, from the north.
    pub lats: Vec<f64>,
    /// The longitude of each column, from the west.
    pub lons: Vec<f64>,
    region: Region,
}

impl CopernicusPlan {
    /// One arc-second: the cell of the 30 m files.
    const FINEST: f64 = 1.0 / 3600.0;

    /// The cells for this region: the files' 1 arc-second, doubled while the grid would pass `max_cells` (each file
    /// then reads the smallest copy of itself that is still as fine).
    pub fn of(region: Region, max_cells: usize) -> Self {
        let Region { south, north, west, east } = region;
        let across = (east - west) * ((south + north) / 2.0).to_radians().cos();
        let want = (north - south).max(across) / (max_cells - 1) as f64;
        let mut level_step = Self::FINEST;
        while level_step * 2.0 <= want {
            level_step *= 2.0;
        }
        let cells = |degrees: f64| {
            let cells = PyFloat::round_whole(degrees / level_step) + 1;
            (cells.max(0) as usize).min(max_cells).max(2)
        };
        let (cols, rows) = (cells(across), cells(north - south));
        let lats = (0..rows).map(|row| north - (north - south) * row as f64 / (rows - 1) as f64).collect();
        let lons = (0..cols).map(|col| west + (east - west) * col as f64 / (cols - 1) as f64).collect();
        Self { want, lats, lons, region }
    }

    /// The degrees (south-west corners) the region touches.
    pub fn degrees(&self) -> Vec<(i32, i32)> {
        let Region { south, north, west, east } = self.region;
        let lons = west.floor() as i32..=east.min(179.9999999).floor() as i32;
        (south.floor() as i32..=north.floor() as i32).flat_map(|lat| lons.clone().map(move |lon| (lat, lon))).collect()
    }

    /// The rows that lie in the degree with this south edge. At the pole's edge, the last row belongs to the last degree.
    pub fn rows_in(&self, lat: i32) -> Vec<usize> {
        let (low, high) = (f64::from(lat), f64::from(lat) + 1.0);
        let inside = |row: f64| row >= low && (high > 90.0 || row < high);
        self.lats.iter().enumerate().filter(|(_, row)| inside(**row)).map(|(at, _)| at).collect()
    }

    /// The columns that lie in the degree with this west edge.
    pub fn cols_in(&self, lon: i32) -> Vec<usize> {
        let (low, high) = (f64::from(lon), f64::from(lon) + 1.0);
        self.lons.iter().enumerate().filter(|(_, col)| **col >= low && **col < high).map(|(at, _)| at).collect()
    }

    /// The region of the grid.
    pub fn region(&self) -> Region {
        self.region
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_of_the_files() {
        let fine = CopernicusModel::ALL[0];
        assert_eq!(fine.file_name(43, 42), "Copernicus_DSM_COG_10_N43_00_E042_00_DEM");
        assert_eq!(CopernicusModel::ALL[1].file_name(-3, -70), "Copernicus_DSM_COG_30_S03_00_W070_00_DEM");
        assert_eq!(
            fine.url(43, 42),
            "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N43_00_E042_00_DEM/Copernicus_DSM_COG_10_N43_00_E042_00_DEM.tif"
        );
    }

    #[test]
    fn a_small_region_takes_the_finest_cells_and_a_big_one_doubles_them() {
        let small = CopernicusPlan::of(Region { south: 0.0, north: 0.1, west: 0.0, east: 0.1 }, 1024);
        assert_eq!(small.lats.len(), 361);
        let big = CopernicusPlan::of(Region { south: 0.0, north: 2.0, west: 0.0, east: 2.0 }, 1024);
        assert_eq!(big.lats.len(), 1024);
    }

    #[test]
    fn the_cells_fall_in_their_degrees() {
        let plan = CopernicusPlan::of(Region { south: 43.5, north: 44.5, west: 42.5, east: 43.5 }, 3);
        assert_eq!(plan.degrees(), [(43, 42), (43, 43), (44, 42), (44, 43)]);
        assert_eq!(plan.lats, [44.5, 44.0, 43.5]);
        assert_eq!(plan.rows_in(44), [0, 1]);
        assert_eq!(plan.rows_in(43), [2]);
        assert_eq!(plan.cols_in(42), [0]);
        assert_eq!(plan.cols_in(43), [1, 2]);
    }

    #[test]
    fn the_top_of_the_world_and_its_east_edge() {
        let plan = CopernicusPlan::of(Region { south: 89.5, north: 90.0, west: 179.5, east: 180.0 }, 3);
        assert_eq!(plan.degrees(), [(89, 179), (90, 179)]);
        assert_eq!(plan.rows_in(90), [0], "at 90 itself");
        assert_eq!(plan.lons, [179.5, 180.0]);
        assert_eq!(plan.cols_in(179), [0], "180 is in no file");
    }
}

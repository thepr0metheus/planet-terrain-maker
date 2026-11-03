//! The Moon's finer heights: SLDEM2015 (LOLA laser heights merged with Kaguya stereo, 59 m a cell, 60 S to 60 N), half
//! the cell size of Trek's LOLA. Trek has no server for it, but the USGS GeoTIFF on S3 is uncompressed int16, one strip
//! per row: a region is one small range request per row of it. Fine for the small regions it is meant for (a 3 km
//! crater is 55 rows); a big region takes Trek's LOLA instead, see `MAX_ROWS`.
//!
//! Heights are metres from the same 1737.4 km sphere as LOLA (int16 x 0.5).

use crate::grid::Grid;
use crate::numbers::PyFloat;
use crate::planets::Planet;
use crate::refused::Refused;
use crate::region::Region;

/// The file, and what it takes to read a region of it.
#[derive(Debug, Clone, PartialEq)]
pub struct SldemPlan {
    region: Region,
    cols: usize,
    rows: usize,
    r_lo: i64,
    r_hi: i64,
    c_lo: i64,
    c_hi: i64,
}

impl SldemPlan {
    /// The file on S3.
    pub const URL: &'static str = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/LolaKaguya_Topo/Lunar_LRO_LOLAKaguya_DEMmerge_60N60S_512ppd.tif";
    /// Where its heights come from, as the page shows it.
    pub const NAME: &'static str = "SLDEM2015 59 m (NASA/GSFC, JAXA)";
    /// Workers that read rows at a time.
    pub const THREADS: usize = 16;
    const FIRST_ROW: i64 = 984003; // byte offset of row 0 (strips are contiguous)
    const WIDTH: i64 = 184320; // pixels a row
    const PX: f64 = 59.2252938; // metres a pixel, on the 1737.4 km sphere
    const X0: f64 = -5458203.076347; // left of pixel 0, metres
    const Y0: f64 = 1819401.025449; // top of pixel 0, metres
    const SCALE: f64 = 0.5;
    const RADIUS: f64 = 1737400.0;
    const NODATA: i16 = -32768;
    const MAX_LAT: f64 = 59.9;
    const MAX_ROWS: f64 = 420.0; // about 25 km of latitude; more is many requests

    fn deg_per_px() -> f64 {
        (Self::PX / Self::RADIUS).to_degrees()
    }

    /// Fractional column whose pixel centre lies at this longitude.
    fn col(lon: f64) -> f64 {
        (Self::RADIUS * lon.to_radians() - Self::X0) / Self::PX - 0.5
    }

    fn row(lat: f64) -> f64 {
        (Self::Y0 - Self::RADIUS * lat.to_radians()) / Self::PX - 0.5
    }

    /// Whether the file holds the region and it is small enough to read row by row.
    pub fn covers(region: &Region) -> bool {
        -Self::MAX_LAT <= region.south
            && region.north <= Self::MAX_LAT
            && Self::row(region.south) - Self::row(region.north) <= Self::MAX_ROWS
    }

    /// What to read for this region: the file's own spacing, within `SMALLEST_GRID` and `max_cells` a side.
    pub fn of(region: Region, max_cells: usize) -> Self {
        let cells = |degrees: f64| {
            let native = PyFloat::round_whole(degrees / Self::deg_per_px()) + 1;
            (native.max(0) as usize).min(max_cells).max(Planet::SMALLEST_GRID)
        };
        Self {
            region,
            cols: cells(region.east - region.west),
            rows: cells(region.north - region.south),
            r_lo: Self::row(region.north).floor() as i64,
            r_hi: Self::row(region.south).ceil() as i64,
            c_lo: Self::col(region.west).floor() as i64,
            c_hi: Self::col(region.east).ceil() as i64,
        }
    }

    /// The rows of the file to read.
    pub fn file_rows(&self) -> Vec<i64> {
        (self.r_lo..=self.r_hi).collect()
    }

    /// The value of `Range` that reads this row's columns.
    pub fn range_of(&self, row: i64) -> String {
        let start = Self::FIRST_ROW + (row * Self::WIDTH + self.c_lo) * 2;
        format!("bytes={start}-{}", start + self.width() as i64 * 2 - 1)
    }

    /// Pixels a row, as read.
    fn width(&self) -> usize {
        (self.c_hi - self.c_lo + 1) as usize
    }

    /// The heights of a row, from what the file sent: metres, NaN where it has none.
    pub fn read_row(&self, body: &[u8]) -> Result<Vec<f64>, Refused> {
        if body.len() != self.width() * 2 {
            return Err(Refused::new(format!("a row of {} bytes, not {}", body.len(), self.width() * 2)));
        }
        let (cells, _) = body.as_chunks::<2>();
        Ok(cells
            .iter()
            .map(|cell| {
                let cell = i16::from_le_bytes(*cell);
                if cell == Self::NODATA { f64::NAN } else { f64::from(cell) * Self::SCALE }
            })
            .collect())
    }

    /// The heights sampled from the north-west corner to the south-east one, from the rows read, in their order.
    pub fn grid(&self, block: &[f64]) -> Result<Grid, Refused> {
        let width = self.width();
        let height = block.len() / width;
        let Region { south, north, west, east } = self.region;
        let mut values = Vec::with_capacity(self.cols * self.rows);
        for row in 0..self.rows {
            let lat = north - (north - south) * row as f64 / (self.rows - 1) as f64;
            let fr = Self::row(lat) - self.r_lo as f64;
            for col in 0..self.cols {
                let lon = west + (east - west) * col as f64 / (self.cols - 1) as f64;
                let fc = Self::col(lon) - self.c_lo as f64;
                values.push(Self::bilinear(block, width, height, fc, fr) as f32);
            }
        }
        Grid::new(self.cols, self.rows, values, self.region, Self::NAME)
    }

    /// A value between the four cells around (fc, fr) of a row-major block; the cells without data are left out, NaN
    /// when all four are without.
    fn bilinear(block: &[f64], width: usize, height: usize, fc: f64, fr: f64) -> f64 {
        let fc = fc.max(0.0).min((width - 1) as f64);
        let fr = fr.max(0.0).min((height - 1) as f64);
        let (c0, r0) = (fc as usize, fr as usize);
        let (c1, r1) = ((c0 + 1).min(width - 1), (r0 + 1).min(height - 1));
        let (tx, ty) = (fc - c0 as f64, fr - r0 as f64);
        let (mut total, mut weight) = (0.0, 0.0);
        for (col, row, share) in
            [(c0, r0, (1.0 - tx) * (1.0 - ty)), (c1, r0, tx * (1.0 - ty)), (c0, r1, (1.0 - tx) * ty), (c1, r1, tx * ty)]
        {
            let value = block.get(row * width + col).copied().unwrap_or(f64::NAN);
            if !value.is_nan() && share > 0.0 {
                total += value * share;
                weight += share;
            }
        }
        if weight > 0.0 { total / weight } else { f64::NAN }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: Region = Region { south: 0.1, north: 0.2, west: 24.1, east: 24.2 };

    #[test]
    fn what_the_file_covers() {
        assert!(SldemPlan::covers(&SMALL));
        assert!(!SldemPlan::covers(&Region { south: 0.0, north: 2.0, west: 24.0, east: 25.0 }), "too many rows");
        assert!(!SldemPlan::covers(&Region { south: 59.8, north: 60.1, west: 24.0, east: 24.1 }), "past the file");
    }

    #[test]
    fn a_range_is_a_row_s_columns() {
        let plan = SldemPlan::of(SMALL, 1024);
        let row = plan.file_rows()[0];
        let start = 984003 + (row * 184320 + plan.c_lo) * 2;
        assert_eq!(plan.range_of(row), format!("bytes={start}-{}", start + plan.width() as i64 * 2 - 1));
        assert!(plan.read_row(&[0; 3]).is_err());
    }

    #[test]
    fn a_grid_of_a_slope_is_the_slope() {
        let plan = SldemPlan::of(SMALL, 1024);
        let (width, height) = (plan.width(), plan.file_rows().len());
        let block: Vec<f64> = (0..width * height).map(|at| (at % width) as f64).collect();
        let grid = plan.grid(&block).unwrap();
        assert!(grid.cols() >= Planet::SMALLEST_GRID);
        let first = f32::from_le_bytes(grid.to_bytes()[..4].try_into().unwrap());
        let wanted = SldemPlan::col(24.1) - plan.c_lo as f64;
        assert!((f64::from(first) - wanted).abs() < 1e-3, "{first} {wanted}");
    }

    #[test]
    fn cells_without_data_are_left_out_and_all_without_is_nan() {
        let n = f64::NAN;
        assert_eq!(SldemPlan::bilinear(&[1.0, n, n, n], 2, 2, 0.5, 0.5), 1.0);
        assert_eq!(SldemPlan::bilinear(&[2.0, 4.0, 2.0, 4.0], 2, 2, 0.5, 0.5), 3.0);
        assert!(SldemPlan::bilinear(&[n, n, n, n], 2, 2, 0.5, 0.5).is_nan());
    }
}

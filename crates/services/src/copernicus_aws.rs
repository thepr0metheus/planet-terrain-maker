//! Heights of a region from the Copernicus files on AWS Open Data, with no key: the files are read by range, and what was
//! read is kept on disk.

use crate::cog::{CogError, CogFile, Reader, Window};
use crate::fetcher::Fetch;
use files::{KeptFiles, Locked, StoreError};
use rules::copernicus::{CopernicusModel, CopernicusPlan};
use rules::{Grid, Region};
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

/// Why there are no heights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopernicusError {
    /// The service failed, or a file is damaged: the words say which.
    Failed(String),
    /// The disk where pieces are kept.
    Store(StoreError),
}

impl fmt::Display for CopernicusError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(words) => out.write_str(words),
            Self::Store(error) => write!(out, "{error}"),
        }
    }
}

impl From<CogError> for CopernicusError {
    fn from(error: CogError) -> Self {
        match error {
            CogError::Store(error) => Self::Store(error),
            other => Self::Failed(other.to_string()),
        }
    }
}

/// A file found for a degree.
struct Found {
    file: CogFile,
    url: String,
    name: &'static str,
}

/// What is known of each degree: `None` is open sea.
type Degrees = HashMap<(i32, i32), Option<Arc<Found>>>;

/// The files, what was read of them, and what is known of each degree.
pub struct CopernicusAws {
    fetcher: Arc<dyn Fetch>,
    pieces: KeptFiles,
    degrees: Locked<Degrees>,
}

impl CopernicusAws {
    const SECONDS: u64 = 60;

    /// The files, with what was read of them kept in this store.
    pub fn new(fetcher: Arc<dyn Fetch>, pieces: KeptFiles) -> Self {
        Self { fetcher, pieces, degrees: Locked::new(HashMap::new()) }
    }

    /// Bytes of a file, from the disk or from the service. A server that ignored the range sent the whole file.
    fn piece(&self, url: &str, start: u64, length: u64) -> Result<Vec<u8>, CogError> {
        if length == 0 {
            return Ok(Vec::new());
        }
        let name = url.rsplit('/').next().unwrap_or(url).trim_end_matches(".tif");
        let relative = PathBuf::from(name).join(format!("{start}-{length}.bin"));
        if let Some(kept) = self.pieces.read(&relative)? {
            return Ok(kept);
        }
        let range = format!("bytes={start}-{}", start + length - 1);
        let body = self.fetcher.get(url, &[("Range", &range)], Self::SECONDS)?.body;
        let body = if body.len() as u64 > length {
            let first = (start as usize).min(body.len());
            let last = ((start + length) as usize).min(body.len());
            body.get(first..last).unwrap_or_default().to_vec()
        } else {
            body
        };
        self.pieces.keep(&relative, &body);
        Ok(body)
    }

    /// The file of a degree; `None` for a degree with no file at all. Where a model has no file, S3 says 403 or 404.
    fn file(&self, lat: i32, lon: i32) -> Result<Option<Arc<Found>>, CogError> {
        if let Some(known) = self.degrees.with(|degrees| degrees.get(&(lat, lon)).cloned()) {
            return Ok(known);
        }
        let mut found = None;
        for model in CopernicusModel::ALL {
            let url = model.url(lat, lon);
            let reader = |start: u64, length: u64| self.piece(&url, start, length);
            match CogFile::open(&reader) {
                Ok(file) => {
                    found = Some(Arc::new(Found { file, url, name: model.name }));
                    break;
                }
                Err(CogError::Fetch(error)) if matches!(error.status, Some(403 | 404)) => {}
                Err(error) => return Err(error),
            }
        }
        self.degrees.with(|degrees| degrees.insert((lat, lon), found.clone()));
        Ok(found)
    }

    /// The heights of a region: open sea, where no file is, is 0 m.
    pub fn grid(&self, region: Region, max_cells: usize) -> Result<Grid, CopernicusError> {
        let plan = CopernicusPlan::of(region, max_cells);
        let (rows, cols) = (plan.lats.len(), plan.lons.len());
        let mut heights = vec![0.0_f32; cols * rows];
        let mut names = BTreeSet::new();
        for (lat, lon) in plan.degrees() {
            let (rows_in, cols_in) = (plan.rows_in(lat), plan.cols_in(lon));
            if rows_in.is_empty() || cols_in.is_empty() {
                continue;
            }
            let Some(found) = self.file(lat, lon)? else {
                continue;
            };
            names.insert(found.name);
            let reader = |start: u64, length: u64| self.piece(&found.url, start, length);
            Self::fill(&found.file, &plan, (&rows_in, &cols_in), &reader, &mut heights)?;
        }
        let source = if names.is_empty() {
            CopernicusModel::OPEN_SEA.to_string()
        } else {
            names.into_iter().collect::<Vec<_>>().join(" + ")
        };
        Grid::new(cols, rows, heights, region, &source).map_err(|refused| CopernicusError::Failed(refused.0))
    }

    /// Fills the cells that lie in one file, each from the four pixels around it. Pixel-is-point: the full image's pixel
    /// i is at lon0 + i * step; a level's pixel covers `factor` of them, centred between their centres.
    fn fill(
        file: &CogFile,
        plan: &CopernicusPlan,
        cells: (&[usize], &[usize]),
        reader: &Reader<'_>,
        heights: &mut [f32],
    ) -> Result<(), CogError> {
        let (rows_in, cols_in) = cells;
        let level = file.level_for(plan.want);
        let factor = file.factor(level);
        let at_col =
            |col: &usize| plan.lons.get(*col).map(|lon| ((lon - file.lon0) / file.step_x + 0.5) / factor - 0.5);
        let at_row =
            |row: &usize| plan.lats.get(*row).map(|lat| ((file.lat0 - lat) / file.step_y + 0.5) / factor - 0.5);
        let fx: Vec<f64> = cols_in.iter().filter_map(at_col).collect();
        let fy: Vec<f64> = rows_in.iter().filter_map(at_row).collect();
        let window = file.window(level, Self::corners(&fx, &fy), reader)?;
        let cols = plan.lons.len();
        for (row, y) in rows_in.iter().zip(&fy) {
            for (col, x) in cols_in.iter().zip(&fx) {
                if let Some(height) = heights.get_mut(row * cols + col) {
                    *height = Self::sampled(&window, *x, *y) as f32;
                }
            }
        }
        Ok(())
    }

    /// The pixels that hold these cells: from the one at or before the first, to the one after the last.
    fn corners(fx: &[f64], fy: &[f64]) -> [i64; 4] {
        let low = |values: &[f64]| values.iter().copied().fold(f64::INFINITY, f64::min).floor() as i64;
        let high = |values: &[f64]| values.iter().copied().fold(f64::NEG_INFINITY, f64::max).floor() as i64 + 1;
        [low(fx), low(fy), high(fx), high(fy)]
    }

    /// The height between the four pixels around (x, y) of a level; past the edge of the window, the edge is held.
    fn sampled(window: &Window, x: f64, y: f64) -> f64 {
        let (last_x, last_y) = (window.width - 1, window.height - 1);
        let gx = (x - window.x0 as f64).max(0.0).min(last_x as f64);
        let gy = (y - window.y0 as f64).max(0.0).min(last_y as f64);
        let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(last_x), (y0 + 1).min(last_y));
        let (tx, ty) = (gx - x0 as f64, gy - y0 as f64);
        let pixel =
            |px: usize, py: usize| f64::from(window.pixels.get(py * window.width + px).copied().unwrap_or(f32::NAN));
        (pixel(x0, y0) * (1.0 - tx) + pixel(x1, y0) * tx) * (1.0 - ty)
            + (pixel(x0, y1) * (1.0 - tx) + pixel(x1, y1) * tx) * ty
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn between_four_pixels() {
        let window = Window { x0: 10, y0: 20, width: 2, height: 2, pixels: vec![0.0, 10.0, 100.0, 110.0] };
        assert_eq!(CopernicusAws::sampled(&window, 10.0, 20.0), 0.0);
        assert_eq!(CopernicusAws::sampled(&window, 10.5, 20.0), 5.0);
        assert_eq!(CopernicusAws::sampled(&window, 10.0, 20.5), 50.0);
        assert_eq!(CopernicusAws::sampled(&window, 10.5, 20.5), 55.0);
        assert_eq!(CopernicusAws::sampled(&window, 99.0, 99.0), 110.0, "past the edge the edge is held");
        assert_eq!(CopernicusAws::sampled(&window, 0.0, 0.0), 0.0);
    }

    #[test]
    fn the_pixels_that_hold_the_cells() {
        assert_eq!(CopernicusAws::corners(&[1.5, 2.5], &[-0.5, 3.0]), [1, -1, 3, 4]);
    }
}

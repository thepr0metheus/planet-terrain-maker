//! A grid of heights, as the server sends it to the page.

use crate::numbers::PyFloat;
use crate::refused::Refused;
use crate::region::Region;

/// Heights in metres, rows from the north, columns from the west, NaN where the source has no height. The corners of
/// the grid are the centres of its corner cells. On the wire it is the raw numbers (float32, little-endian), and its
/// size and place go in the fields: a 1000 x 1000 grid is 4 MB this way, and about 9 MB as JSON text.
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    cols: usize,
    rows: usize,
    values: Vec<f32>,
    region: Region,
    source: String,
}

impl Grid {
    /// A grid of these cells; refused when the cells are too few, or their values are not as many.
    pub fn new(cols: usize, rows: usize, values: Vec<f32>, region: Region, source: &str) -> Result<Self, Refused> {
        if cols < 2 || rows < 2 {
            return Err(Refused::new(format!("a grid needs 2 x 2 cells at least, not {cols} x {rows}")));
        }
        if Some(values.len()) != cols.checked_mul(rows) {
            return Err(Refused::new(format!("{cols} x {rows} cells, but {} values", values.len())));
        }
        Ok(Self { cols, rows, values, region, source: source.to_string() })
    }

    /// Cells across.
    pub fn cols(&self) -> usize {
        self.cols
    }

    /// Cells down.
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// Where the grid comes from.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The heights, as they go on the wire.
    pub fn to_bytes(&self) -> Vec<u8> {
        self.values.iter().flat_map(|value| value.to_le_bytes()).collect()
    }

    /// The fields that say its size and place.
    pub fn fields(&self) -> [(&'static str, String); 4] {
        let Region { south, north, west, east } = self.region;
        [
            ("X-Grid-Cols", self.cols.to_string()),
            ("X-Grid-Rows", self.rows.to_string()),
            (
                "X-Grid-Box",
                format!(
                    "{},{},{},{}",
                    PyFloat::repr(south),
                    PyFloat::repr(north),
                    PyFloat::repr(west),
                    PyFloat::repr(east)
                ),
            ),
            ("X-Grid-Source", self.source.clone()),
        ]
    }

    /// The same ground in at most `max_cells` a side. The corners stay where they are, the new cells are spaced evenly
    /// between them, and each is the mean of the old cells within half a new step of it (those with a height). A grid
    /// within the limit comes back as it is.
    pub fn reduced(self, max_cells: usize) -> Self {
        if self.cols.max(self.rows) <= max_cells {
            return self;
        }
        let step = (self.cols.max(self.rows) - 1) as f64 / (max_cells - 1) as f64;
        let cols = Self::cells_of(self.cols, step);
        let rows = Self::cells_of(self.rows, step);
        let spans_x = Self::spans(self.cols, cols);
        let spans_y = Self::spans(self.rows, rows);
        let mut out = Vec::with_capacity(cols * rows);
        for (r0, r1) in &spans_y {
            for (c0, c1) in &spans_x {
                out.push(self.mean_of(*r0, *r1, *c0, *c1));
            }
        }
        Self { cols, rows, values: out, region: self.region, source: self.source }
    }

    fn cells_of(old: usize, step: f64) -> usize {
        (PyFloat::round_whole((old - 1) as f64 / step) + 1).max(2) as usize
    }

    /// The old cells within half a new step of each new cell.
    fn spans(old: usize, new: usize) -> Vec<(usize, usize)> {
        let step = (old - 1) as f64 / (new - 1) as f64;
        (0..new)
            .map(|at| {
                let centre = at as f64 * step;
                let first = (centre - step / 2.0).ceil().max(0.0) as usize;
                let last = ((centre + step / 2.0).floor() as usize).min(old - 1);
                (first, last)
            })
            .collect()
    }

    fn mean_of(&self, r0: usize, r1: usize, c0: usize, c1: usize) -> f32 {
        let (mut total, mut count) = (0.0_f64, 0_u32);
        for row in r0..=r1 {
            let base = row * self.cols;
            // absent-ok: the spans lie inside the grid by their arithmetic.
            for value in self.values.get(base + c0..=base + c1).unwrap_or_default() {
                if !value.is_nan() {
                    total += f64::from(*value);
                    count += 1;
                }
            }
        }
        if count == 0 { f32::NAN } else { (total / f64::from(count)) as f32 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLACE: Region = Region { south: 10.0, north: 11.0, west: 20.0, east: 21.0 };

    fn floats(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks(4).map(|four| f32::from_le_bytes(four.try_into().unwrap())).collect()
    }

    #[test]
    fn bytes_are_float32_with_nan_for_no_height() {
        let grid = Grid::new(2, 2, vec![1.5, f32::NAN, -3.0, 4.0], PLACE, "test").unwrap();
        let values = floats(&grid.to_bytes());
        assert_eq!(values[0], 1.5);
        assert!(values[1].is_nan());
        assert_eq!(grid.fields()[0], ("X-Grid-Cols", "2".to_string()));
        assert_eq!(grid.fields()[2], ("X-Grid-Box", "10.0,11.0,20.0,21.0".to_string()));
    }

    #[test]
    fn a_grid_needs_its_values() {
        assert!(Grid::new(2, 2, vec![1.0, 2.0, 3.0], PLACE, "test").is_err());
        assert!(Grid::new(1, 5, vec![1.0; 5], PLACE, "test").is_err());
    }

    #[test]
    fn reduced_keeps_the_corners_and_averages() {
        let values = (0..81).map(|at| (at % 9) as f32).collect();
        let grid = Grid::new(9, 9, values, PLACE, "test").unwrap().reduced(5);
        assert_eq!((grid.cols, grid.rows), (5, 5));
        assert_eq!(grid.region, PLACE);
        assert_eq!(grid.values[..5], [0.5, 2.0, 4.0, 6.0, 7.5]);
    }

    #[test]
    fn reduced_leaves_out_cells_without_height() {
        let n = f32::NAN;
        let grid = Grid::new(3, 3, vec![n, n, n, n, 5.0, n, n, n, n], PLACE, "t").unwrap().reduced(2);
        assert_eq!((grid.cols, grid.rows), (2, 2));
        assert!(grid.values.iter().all(|value| *value == 5.0));
    }

    #[test]
    fn a_long_grid_keeps_its_shape_and_a_grid_within_the_limit_stays() {
        let long = Grid::new(100, 3, vec![1.0; 300], PLACE, "t").unwrap().reduced(10);
        assert_eq!((long.cols, long.rows), (10, 2));
        let small = Grid::new(3, 3, vec![0.0; 9], PLACE, "t").unwrap();
        assert_eq!(small.clone().reduced(3), small);
    }
}

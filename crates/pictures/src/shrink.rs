//! A picture made smaller, the way the copies kept so far were made (Pillow's `draft`, `thumbnail` and LANCZOS): a JPEG
//! decoded smaller by a whole factor, then an average over whole blocks of points, which is cheap, then the Lanczos filter
//! for what is left.

use crate::rgb::Rgb;

/// The size of a copy, and the steps that make it.
pub struct Shrink;

impl Shrink {
    /// The reach of the Lanczos filter, in points of the smaller side.
    const LANCZOS: f64 = 3.0;
    /// How much bigger than asked the picture stays after the blocks, for the filter to work on.
    const REDUCING_GAP: f64 = 2.0;

    /// The size that keeps the shape and fits in `most` a side. A side never goes to nothing.
    pub fn fitting(width: usize, height: usize, most: usize) -> (usize, usize) {
        if most >= width && most >= height {
            return (width, height);
        }
        let aspect = width as f64 / height as f64;
        let side = most as f64;
        if 1.0 >= aspect {
            let error = |n: f64| (aspect - n / side).abs();
            (Self::nearest(side * aspect, error), most)
        } else {
            let error = |n: f64| if n == 0.0 { 0.0 } else { (aspect - side / n).abs() };
            (most, Self::nearest(side / aspect, error))
        }
    }

    /// The whole number below or above `number` with the smaller error, the lower of the two in a tie, at least 1.
    fn nearest(number: f64, error: impl Fn(f64) -> f64) -> usize {
        let (low, high) = (number.floor(), number.ceil());
        let chosen = if error(high) < error(low) { high } else { low };
        (chosen as usize).max(1)
    }

    /// The factor a JPEG is decoded smaller by, 1, 2, 4 or 8: what Pillow's `draft` asked of its decoder.
    pub(crate) fn draft_factor(width: usize, height: usize, most: usize) -> usize {
        let scale = (width / most).min(height / most);
        [8, 4, 2].into_iter().find(|factor| scale >= *factor).unwrap_or(1)
    }

    /// `picture` at this size: blocks first, while they leave `REDUCING_GAP` times the size, then the filter.
    pub(crate) fn to_size(picture: Rgb, width: usize, height: usize) -> Rgb {
        let factor = |from: usize, to: usize| ((from as f64 / to as f64 / Self::REDUCING_GAP) as usize).max(1);
        let (fx, fy) = (factor(picture.width, width), factor(picture.height, height));
        let reduced = if fx > 1 || fy > 1 { Self::reduced(&picture, fx, fy) } else { picture };
        if (reduced.width, reduced.height) == (width, height) {
            return reduced;
        }
        Self::lanczos(&reduced, width, height)
    }

    /// Each new point the mean of the block of `fx` by `fy` points under it. The last blocks of a side may hold fewer.
    pub(crate) fn reduced(picture: &Rgb, fx: usize, fy: usize) -> Rgb {
        let width = picture.width.div_ceil(fx);
        let height = picture.height.div_ceil(fy);
        let stride = picture.width * 3;
        let mut points = Vec::with_capacity(width * height * 3);
        for block in picture.points.chunks(stride * fy) {
            let rows = block.len() / stride;
            let mut totals = vec![0_u32; width * 3];
            for row in block.chunks(stride) {
                for (total, pieces) in totals.as_chunks_mut::<3>().0.iter_mut().zip(row.chunks(3 * fx)) {
                    for [r, g, b] in pieces.as_chunks::<3>().0 {
                        total[0] += u32::from(*r);
                        total[1] += u32::from(*g);
                        total[2] += u32::from(*b);
                    }
                }
            }
            for (at, total) in totals.as_chunks::<3>().0.iter().enumerate() {
                let across = fx.min(picture.width - at * fx);
                let count = (across * rows) as u32;
                points.extend(total.iter().map(|sum| ((sum + count / 2) / count) as u8));
            }
        }
        Rgb { width, height, points }
    }

    fn lanczos(picture: &Rgb, width: usize, height: usize) -> Rgb {
        let across = Self::weights(picture.width, width);
        let mut wide = Vec::with_capacity(width * picture.height * 3);
        for row in picture.points.chunks_exact(picture.width * 3) {
            Self::row_filtered(row, &across, &mut wide);
        }
        let down = Self::weights(picture.height, height);
        let stride = width * 3;
        let rows: Vec<&[u8]> = wide.chunks_exact(stride).collect();
        let mut points = Vec::with_capacity(stride * height);
        let mut totals = vec![0.0_f32; stride];
        for (first, weights) in &down {
            totals.fill(0.0);
            for (row, weight) in rows.iter().skip(*first).zip(weights) {
                for (total, sample) in totals.iter_mut().zip(row.iter()) {
                    *total += f32::from(*sample) * weight;
                }
            }
            points.extend(totals.iter().map(|total| Self::byte(*total)));
        }
        Rgb { width, height, points }
    }

    fn row_filtered(row: &[u8], across: &[(usize, Vec<f32>)], out: &mut Vec<u8>) {
        let (cells, _) = row.as_chunks::<3>();
        for (first, weights) in across {
            let mut total = [0.0_f32; 3];
            for ([r, g, b], weight) in cells.iter().skip(*first).zip(weights) {
                total[0] += f32::from(*r) * weight;
                total[1] += f32::from(*g) * weight;
                total[2] += f32::from(*b) * weight;
            }
            out.extend(total.map(Self::byte));
        }
    }

    fn byte(value: f32) -> u8 {
        (value + 0.5).clamp(0.0, 255.0) as u8
    }

    /// For each new point: the first old point it reads, and the weight of each one from there.
    fn weights(from: usize, to: usize) -> Vec<(usize, Vec<f32>)> {
        let scale = from as f64 / to as f64;
        let stretch = scale.max(1.0);
        let reach = Self::LANCZOS * stretch;
        (0..to)
            .map(|at| {
                let centre = (at as f64 + 0.5) * scale;
                let first = (centre - reach + 0.5).max(0.0) as usize;
                let last = ((centre + reach + 0.5) as usize).min(from);
                let weights: Vec<f64> =
                    (first..last).map(|old| Self::filter((old as f64 - centre + 0.5) / stretch)).collect();
                let total: f64 = weights.iter().sum();
                (first, weights.iter().map(|weight| (weight / total) as f32).collect())
            })
            .collect()
    }

    fn filter(x: f64) -> f64 {
        if x.abs() >= Self::LANCZOS {
            return 0.0;
        }
        Self::sinc(x) * Self::sinc(x / Self::LANCZOS)
    }

    fn sinc(x: f64) -> f64 {
        if x == 0.0 {
            return 1.0;
        }
        let angle = x * std::f64::consts::PI;
        angle.sin() / angle
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rgb::samples::rgb;

    #[test]
    fn the_size_of_a_copy_is_what_pillow_made() {
        for (width, height, most, want) in [
            (1200, 800, 300, (300, 200)),
            (800, 1200, 300, (200, 300)),
            (1000, 1000, 64, (64, 64)),
            (4000, 100, 100, (100, 3)),
            (100, 4000, 100, (3, 100)),
            (640, 480, 64, (64, 48)),
            (100000, 1, 64, (64, 1)),
            (300, 200, 300, (300, 200)),
        ] {
            assert_eq!(Shrink::fitting(width, height, most), want, "{width}x{height} in {most}");
        }
    }

    #[test]
    fn the_factor_of_the_first_step() {
        assert_eq!(Shrink::draft_factor(8192, 8192, 4096), 2);
        assert_eq!(Shrink::draft_factor(8192, 8192, 1024), 8);
        assert_eq!(Shrink::draft_factor(8192, 8192, 512), 8);
        assert_eq!(Shrink::draft_factor(1200, 800, 300), 2);
        assert_eq!(Shrink::draft_factor(4000, 100, 100), 1);
        assert_eq!(Shrink::draft_factor(500, 500, 300), 1);
    }

    #[test]
    fn a_block_is_the_mean_of_its_points_and_the_last_may_be_smaller() {
        let picture = rgb(3, 3, |x, y| [(x * 10) as u8, (y * 10) as u8, 7]);
        let small = Shrink::reduced(&picture, 2, 2);
        assert_eq!((small.width, small.height), (2, 2));
        assert_eq!(small.points[..3], [5, 5, 7]);
        assert_eq!(small.points[3..6], [20, 5, 7]);
        assert_eq!(small.points[6..9], [5, 20, 7]);
        assert_eq!(small.points[9..12], [20, 20, 7]);
    }

    #[test]
    fn one_colour_stays_that_colour() {
        let picture = rgb(100, 60, |_, _| [40, 120, 60]);
        for (width, height) in [(50, 30), (37, 23), (10, 6), (1, 1)] {
            let small = Shrink::to_size(picture.clone(), width, height);
            assert_eq!((small.width, small.height), (width, height));
            assert!(small.points.as_chunks::<3>().0.iter().all(|point| *point == [40, 120, 60]), "{width}x{height}");
        }
    }

    #[test]
    fn a_slope_stays_a_slope() {
        let picture = rgb(256, 8, |x, _| [x as u8, x as u8, x as u8]);
        let small = Shrink::lanczos(&picture, 64, 2);
        let row: Vec<u8> = small.points[..64 * 3].iter().step_by(3).copied().collect();
        assert!(row.windows(2).all(|pair| pair[0] <= pair[1]), "{row:?}");
        assert!(row[0] < 8 && row[63] > 247, "{row:?}");
    }
}

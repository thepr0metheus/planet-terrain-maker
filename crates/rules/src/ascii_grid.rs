//! An ESRI ASCII grid: what OpenTopography sends.

use crate::grid::Grid;
use crate::letters::Letters;
use crate::numbers::{Decimal, Whole};
use crate::refused::Refused;
use crate::region::Region;
use std::collections::HashMap;

/// The reading of an ASCII grid. Its head gives the lower-left corner of the lower-left cell (or its centre) and the
/// cell size, in degrees; the numbers come row by row from the north.
pub struct AsciiGrid;

impl AsciiGrid {
    /// The grid this text holds, with this name for where it comes from.
    pub fn parse(text: &str, source: &str) -> Result<Grid, Refused> {
        let lines: Vec<&str> = text.lines().collect();
        let (head, at) = Self::head(&lines);
        let (cols, rows, size) = Self::size(&head)?;
        let nodata = Self::number(&head, "nodata_value", -9999.0)?;
        let (west, south) = Self::corner(&head, size)?;
        let wanted = cols.checked_mul(rows).filter(|wanted| *wanted >= 0);
        let values = Self::values(lines.get(at..).unwrap_or_default(), wanted, nodata)?;
        let region =
            Region { south, north: south + size * (rows - 1) as f64, west, east: west + size * (cols - 1) as f64 };
        Grid::new(cols.max(0) as usize, rows.max(0) as usize, values, region, source)
    }

    /// The fields of the head, in small letters, and the line where the numbers start.
    fn head<'a>(lines: &[&'a str]) -> (HashMap<String, &'a str>, usize) {
        let mut head = HashMap::new();
        for (at, line) in lines.iter().enumerate() {
            match Letters::words(line).as_slice() {
                [name, value] if Self::is_name(name) => {
                    head.insert(name.to_lowercase(), *value);
                }
                _ => return (head, at),
            }
        }
        (head, lines.len())
    }

    fn is_name(word: &str) -> bool {
        let letters: Vec<char> = word.chars().filter(|letter| *letter != '_').collect();
        !letters.is_empty() && letters.iter().all(|letter| letter.is_alphabetic())
    }

    fn size(head: &HashMap<String, &str>) -> Result<(i64, i64, f64), Refused> {
        let whole = |name: &str| head.get(name).and_then(|value| Whole::read(value));
        let cols = whole("ncols");
        let rows = whole("nrows");
        let size = head.get("cellsize").and_then(|value| Decimal::read(value));
        match (cols, rows, size) {
            (Some(cols), Some(rows), Some(size)) => Ok((cols, rows, size)),
            _ => Err(Refused::new("not an ASCII grid: no ncols, nrows or cellsize in its header")),
        }
    }

    fn number(head: &HashMap<String, &str>, name: &str, otherwise: f64) -> Result<f64, Refused> {
        match head.get(name) {
            None => Ok(otherwise),
            Some(value) => Decimal::read(value).ok_or_else(|| Refused::new(format!("{name} is no number: {value}"))),
        }
    }

    /// The centre of the lower-left cell: (west, south).
    fn corner(head: &HashMap<String, &str>, size: f64) -> Result<(f64, f64), Refused> {
        let needed = |name: &str| {
            head.get(name)
                .and_then(|value| Decimal::read(value))
                .ok_or_else(|| Refused::new(format!("not an ASCII grid: no {name} in its header")))
        };
        if head.contains_key("xllcenter") {
            Ok((needed("xllcenter")?, needed("yllcenter")?))
        } else {
            Ok((needed("xllcorner")? + size / 2.0, needed("yllcorner")? + size / 2.0))
        }
    }

    fn values(lines: &[&str], wanted: Option<i64>, nodata: f64) -> Result<Vec<f32>, Refused> {
        let tokens: Vec<&str> = lines.iter().flat_map(|line| Letters::words(line)).collect();
        let found = tokens.len() as i64;
        let wanted = wanted
            .filter(|wanted| *wanted <= found)
            .ok_or_else(|| Refused::new(format!("the grid is cut short: {found} values are not all it says it has")))?;
        tokens
            .iter()
            .take(wanted as usize)
            .map(|token| {
                let value = Decimal::read(token).ok_or_else(|| Refused::new(format!("{token} is no number")))?;
                Ok(if value == nodata || !value.is_finite() { f32::NAN } else { value as f32 })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_of(grid: &Grid) -> String {
        grid.fields()[2].1.clone()
    }

    #[test]
    fn by_its_corner_and_by_its_centre() {
        let text =
            "ncols 3\nnrows 2\nxllcorner 10.0\nyllcorner 40.0\ncellsize 0.5\nNODATA_value -9999\n1 2 3\n4 -9999 6\n";
        let grid = AsciiGrid::parse(text, "src").unwrap();
        assert_eq!((grid.cols(), grid.rows()), (3, 2));
        assert_eq!(box_of(&grid), "40.25,40.75,10.25,11.25");
        assert!(f32::from_le_bytes(grid.to_bytes()[16..20].try_into().unwrap()).is_nan());
        let centre =
            AsciiGrid::parse("ncols 2\nnrows 2\nxllcenter 1\nyllcenter 2\ncellsize 1\n1 2 3 4\n", "src").unwrap();
        assert_eq!(box_of(&centre), "2.0,3.0,1.0,2.0");
    }

    #[test]
    fn cut_short_or_without_a_head() {
        for text in [
            "ncols 3\nnrows 3\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3\n",
            "<html>Server busy</html>",
            "ncols x\nnrows 3\ncellsize 1\n",
            "ncols 2\nnrows 2\ncellsize 1\n1 2 3 4\n",
            "ncols 2\nnrows 2\nxllcenter 1\ncellsize 1\n1 2 3 4\n",
            "ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\na b c d\n",
            "ncols 1\nnrows 5\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3 4 5\n",
            "ncols -2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\n1 2 3 4\n",
            "ncols 99999999999\nnrows 99999999999\nxllcorner 0\nyllcorner 0\ncellsize 1\n1\n",
        ] {
            assert!(AsciiGrid::parse(text, "src").is_err(), "{text}");
        }
    }
}

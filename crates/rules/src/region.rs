//! A region of a world, and the numbers a request names it by.

use crate::numbers::{Decimal, Whole};
use crate::refused::Refused;

/// South, north, west and east, in degrees. One a request names is checked by `Region::asked`; one a service's grid
/// covers is what the service says it is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    /// The south edge.
    pub south: f64,
    /// The north edge.
    pub north: f64,
    /// The west edge.
    pub west: f64,
    /// The east edge.
    pub east: f64,
}

impl Region {
    /// The region a request names: four numbers within -90..90 and -180..180, south below north and west of east.
    pub fn asked(
        south: Option<&str>,
        north: Option<&str>,
        west: Option<&str>,
        east: Option<&str>,
    ) -> Result<Self, Refused> {
        let south = AskedNumber::read("south", south, Some(-90.0), Some(90.0))?;
        let north = AskedNumber::read("north", north, Some(-90.0), Some(90.0))?;
        let west = AskedNumber::read("west", west, Some(-180.0), Some(180.0))?;
        let east = AskedNumber::read("east", east, Some(-180.0), Some(180.0))?;
        if !(south < north && west < east) {
            return Err(Refused::new("the region needs south < north and west < east"));
        }
        Ok(Self { south, north, west, east })
    }
}

/// A number a request names.
pub struct AskedNumber;

impl AskedNumber {
    /// The number, within its limits.
    pub fn read(name: &str, raw: Option<&str>, low: Option<f64>, high: Option<f64>) -> Result<f64, Refused> {
        let value = raw.and_then(Decimal::read).ok_or_else(|| Refused::new(format!("{name} must be a number")))?;
        let under = low.is_some_and(|low| value < low);
        let over = high.is_some_and(|high| value > high);
        if !value.is_finite() || under || over {
            return Err(Refused::new(format!("{name} is out of range")));
        }
        Ok(value)
    }
}

/// Cells a side of a grid of heights.
pub struct Cells;

impl Cells {
    /// The most a request may ask, and what it gets when it asks none.
    pub const MOST: usize = 1024;

    /// What a request asks.
    pub fn asked(raw: Option<&str>) -> Result<usize, Refused> {
        let Some(raw) = raw else {
            return Ok(Self::MOST);
        };
        let cells = Whole::read(raw).ok_or_else(|| Refused::new("cells must be a whole number"))?;
        if !(2..=Self::MOST as i64).contains(&cells) {
            return Err(Refused::new(format!("cells must be within 2..{}", Self::MOST)));
        }
        Ok(cells as usize)
    }
}

/// The size of a picture of a region.
pub struct PictureSize;

impl PictureSize {
    /// The most points a side.
    pub const MOST: f64 = 4096.0;
    const LEAST: f64 = 2.0;

    /// What a request asks: points across and down, each cut to a whole number.
    pub fn asked(width: Option<&str>, height: Option<&str>) -> Result<(usize, usize), Refused> {
        let side = |name: &str, raw: Option<&str>| AskedNumber::read(name, raw, Some(Self::LEAST), Some(Self::MOST));
        Ok((side("width", width)? as usize, side("height", height)? as usize))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(south: &str, north: &str, west: &str, east: &str) -> Result<Region, Refused> {
        Region::asked(Some(south), Some(north), Some(west), Some(east))
    }

    #[test]
    fn a_region_is_four_numbers_in_their_order() {
        assert_eq!(region("0", "1", "2", "3").unwrap(), Region { south: 0.0, north: 1.0, west: 2.0, east: 3.0 });
        assert_eq!(region("1", "0", "0", "1").unwrap_err().0, "the region needs south < north and west < east");
        assert_eq!(region("a", "1", "0", "1").unwrap_err().0, "south must be a number");
        assert_eq!(region("nan", "1", "0", "1").unwrap_err().0, "south is out of range");
        assert_eq!(region("0", "1", "0", "181").unwrap_err().0, "east is out of range");
        assert_eq!(Region::asked(None, Some("1"), Some("0"), Some("1")).unwrap_err().0, "south must be a number");
    }

    #[test]
    fn cells_and_the_size_of_a_picture() {
        assert_eq!(Cells::asked(None).unwrap(), 1024);
        assert_eq!(Cells::asked(Some("2")).unwrap(), 2);
        assert_eq!(Cells::asked(Some("a")).unwrap_err().0, "cells must be a whole number");
        assert_eq!(Cells::asked(Some("1025")).unwrap_err().0, "cells must be within 2..1024");
        assert_eq!(PictureSize::asked(Some("100"), Some("50.9")).unwrap(), (100, 50));
        assert!(PictureSize::asked(Some("1"), Some("50")).is_err());
        assert!(PictureSize::asked(Some("4097"), Some("50")).is_err());
        assert!(PictureSize::asked(None, Some("50")).is_err());
    }
}

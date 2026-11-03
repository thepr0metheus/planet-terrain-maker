//! Heights of a region on Earth from Copernicus DEM, through OpenTopography's API, and its key: the one secret the app
//! has. The other Earth heights, AWS Terrain Tiles, need no server work: they are map tiles, which the page fetches
//! through the tile relay and reads itself.

use crate::letters::Letters;
use crate::numbers::PyFloat;
use crate::percent::Percent;
use crate::refused::Refused;
use crate::region::Region;

/// What is asked of OpenTopography.
pub struct OpenTopoRequest;

impl OpenTopoRequest {
    const URL: &'static str = "https://portal.opentopography.org/API/globaldem";
    /// The finer model while the region fits in `REQUEST_CELLS` a side.
    const REQUEST_CELLS: f64 = 1600.0;
    const CELL: f64 = 1.0 / 3600.0;

    /// The model to ask for: its name there, and its name as the page shows it. 30 m while the region is at most
    /// `REQUEST_CELLS` of it a side.
    pub fn model(region: &Region) -> (&'static str, &'static str) {
        let cells = (region.north - region.south).max(region.east - region.west) / Self::CELL;
        if cells <= Self::REQUEST_CELLS {
            ("COP30", "Copernicus DEM 30 m (ESA), via OpenTopography")
        } else {
            ("COP90", "Copernicus DEM 90 m (ESA), via OpenTopography")
        }
    }

    /// The address that asks for this region with this key.
    pub fn url(region: &Region, key: &str) -> String {
        let edge = |value: f64| PyFloat::repr(value);
        let form = Percent::form(&[
            ("demtype", Self::model(region).0.to_string()),
            ("south", edge(region.south)),
            ("north", edge(region.north)),
            ("west", edge(region.west)),
            ("east", edge(region.east)),
            ("outputFormat", "AAIGrid".to_string()),
            ("API_Key", key.to_string()),
        ]);
        format!("{}?{form}", Self::URL)
    }
}

/// What a key may be.
pub struct OpenTopoKey;

impl OpenTopoKey {
    /// A key as it is kept: without the spaces around it, and refused when it is no key. OpenTopography's keys are 32
    /// hex digits; a little room either way, nothing that could break a URL.
    pub fn checked(key: &str) -> Result<&str, Refused> {
        let key = Letters::strip(key);
        let allowed = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-');
        if (16..=128).contains(&key.len()) && key.bytes().all(allowed) {
            Ok(key)
        } else {
            Err(Refused::new("A key is 16 to 128 letters, digits, '-' or '_'."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn big_regions_take_the_90_m_model() {
        let of = |side: f64| {
            OpenTopoRequest::model(&Region { south: 40.0, north: 40.0 + side, west: 40.0, east: 40.0 + side }).0
        };
        assert_eq!(of(0.3), "COP30");
        assert_eq!(of(1.0), "COP90");
    }

    #[test]
    fn the_address() {
        let place = Region { south: 41.5, north: 41.6, west: 0.00001, east: 41.6 };
        assert_eq!(
            OpenTopoRequest::url(&place, "KEY"),
            "https://portal.opentopography.org/API/globaldem?demtype=COP90&south=41.5&north=41.6&west=1e-05&east=41.6&outputFormat=AAIGrid&API_Key=KEY"
        );
    }

    #[test]
    fn what_is_a_key() {
        assert_eq!(OpenTopoKey::checked("  0123456789abcdef-_ \n").unwrap(), "0123456789abcdef-_");
        for bad in ["short", &"a".repeat(129), "has a space in the middle", "გასაღებიგასაღებიგასაღები"]
        {
            assert!(OpenTopoKey::checked(bad).is_err(), "{bad}");
        }
    }
}

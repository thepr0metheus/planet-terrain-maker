//! The services the app takes its data from: map tiles (Esri, EOX, NASA Trek, AWS), heights (OpenTopography, Trek, USGS,
//! Copernicus on AWS), names (Nominatim), buildings (Overpass), shapes of asteroids, comets and spacecraft. They are other
//! people's. Everything asked of them goes through one `Fetch`, and what they answer is kept on disk where it is kept.

pub mod cog;
pub mod copernicus_aws;
pub mod fetcher;
pub mod nominatim;
pub mod opentopography;
pub mod overpass;
pub mod shape_files;
pub mod tile_relay;
pub mod trek;

pub use copernicus_aws::{CopernicusAws, CopernicusError};
pub use fetcher::{Answer, Fetch, FetchError, HttpFetcher};
pub use nominatim::{Nominatim, PlaceError};
pub use opentopography::{HeightsError, OpenTopography};
pub use overpass::{BuildingsError, Overpass};
pub use shape_files::{ShapeError, ShapeFiles};
pub use tile_relay::{Tile, TileError, TileRelay};
pub use trek::{PlanetError, Trek};

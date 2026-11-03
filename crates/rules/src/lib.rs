//! What is valid and how a thing is read and computed: pure values. This crate touches no file, socket, thread,
//! environment or clock, so that every decision in it is tested with values alone.

pub mod ascii_grid;
pub mod buildings;
pub mod clock;
pub mod copernicus;
pub mod detail_tile;
pub mod digest;
pub mod grid;
pub mod json_form;
pub mod letters;
pub mod model_meta;
pub mod numbers;
pub mod opentopo;
pub mod percent;
pub mod picture_source;
pub mod places;
pub mod planets;
pub mod py_text;
pub mod refused;
pub mod region;
pub mod settings;
pub mod shapes;
pub mod sldem;
pub mod stamp;
pub mod tile_source;

pub use clock::{Clock, StillClock};
pub use digest::Digest;
pub use grid::Grid;
pub use json_form::JsonForm;
pub use letters::Letters;
pub use numbers::{Decimal, PyFloat, Whole};
pub use percent::Percent;
pub use py_text::PyText;
pub use refused::Refused;
pub use region::Region;
pub use stamp::Stamp;

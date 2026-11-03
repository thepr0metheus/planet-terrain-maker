//! The pictures the server reads: JPEG and PNG, and nothing else. The holes found in picture libraries keep turning up
//! in the readers of the rarer kinds (TIFF, GIF, EPS): a file of any other kind is not a picture here. Only this crate
//! has the packages that read them.

pub mod copy;
pub mod head;
pub mod rgb;
pub mod shrink;

pub use copy::SmallerCopy;
pub use head::{NotAPicture, PictureHead, PictureKind};
pub use rgb::Rgb;

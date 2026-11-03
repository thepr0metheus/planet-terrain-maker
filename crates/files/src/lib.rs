//! Everything on disk, under the data folder: one writer a file, and each file replaced whole, so that a reader sees the
//! old one or the new one, never half. No socket and no HTTP here: a store says what happened, and a route what that means.

pub mod atomic;
pub mod client_errors;
pub mod detail_tiles;
pub mod json_file;
pub mod kept_files;
pub mod key_store;
pub mod library;
pub mod locked;
pub mod log;
pub mod picture_copies;
pub mod picture_sources;
pub mod random;
pub mod settings_file;
pub mod store_error;
pub mod tile_store;

pub use atomic::AtomicFile;
pub use client_errors::ClientErrors;
pub use detail_tiles::{DetailError, DetailTiles};
pub use kept_files::KeptFiles;
pub use key_store::KeyStore;
pub use library::{Library, LibraryError};
pub use locked::Locked;
pub use log::Log;
pub use picture_copies::{CopyError, PictureCopies, SmallerPicture};
pub use picture_sources::{PictureSources, SourceError};
pub use settings_file::{SettingsError, SettingsFile};
pub use store_error::StoreError;
pub use tile_store::{TileAddress, TileStore};

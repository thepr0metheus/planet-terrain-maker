//! A JSON file read one way, for every store that keeps one.

use serde_json::Value;
use std::fs;
use std::io;
use std::path::Path;

/// What a JSON file holds, and the two ways it can hold nothing: a store decides what each means.
#[derive(Debug, PartialEq)]
pub enum JsonRead {
    /// There is no such file.
    Absent,
    /// It is there, and it is not JSON.
    Broken,
    /// What it says.
    Value(Value),
}

impl JsonRead {
    /// Reads the file. An error of the disk is not one of the three: nothing is known of the file then.
    pub fn of(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).map_or(Self::Broken, Self::Value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::Absent),
            Err(error) => Err(error),
        }
    }
}

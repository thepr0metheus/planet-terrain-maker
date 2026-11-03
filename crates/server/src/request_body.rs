//! Reading what a request carries beyond its head.

use crate::exchange::Exchange;
use crate::failure::Failure;
use serde_json::{Map, Value};
use std::io::Read as _;
use wire::{ContentLength, Multipart, MultipartError};

/// What a model's upload holds: its meta and its files, each by its name, the first of a name when one comes twice.
pub struct Upload<'b> {
    /// The meta, read as JSON.
    pub meta: Value,
    /// The files.
    pub files: Vec<(String, &'b [u8])>,
}

impl<'b> Upload<'b> {
    /// The most bytes a field that is no file may have, and the most parts.
    const MOST_FIELD: usize = 500_000;
    const MOST_PARTS: usize = 1000;

    /// Reads a body. A body that says it is not multipart, or is not made as it says, has no meta.
    fn read(body: &'b [u8], boundary: Option<&str>) -> Result<Self, Failure> {
        let parts = match boundary.map(|boundary| Multipart::parts(body, boundary, Self::MOST_PARTS)) {
            Some(Ok(parts)) => parts,
            Some(Err(MultipartError::TooMany)) => return Err(Failure::Page(413)),
            Some(Err(MultipartError::Unreadable)) | None => Vec::new(),
        };
        let mut meta = None;
        let mut files: Vec<(String, &[u8])> = Vec::new();
        for part in parts {
            if part.is_file {
                if !files.iter().any(|(name, _)| *name == part.name) {
                    files.push((part.name, part.body));
                }
            } else {
                if part.body.len() > Self::MOST_FIELD {
                    return Err(Failure::Page(413));
                }
                if part.name == "meta" && meta.is_none() {
                    meta = Some(part.body);
                }
            }
        }
        let meta = meta
            .and_then(|meta| serde_json::from_str(&String::from_utf8_lossy(meta)).ok())
            .ok_or_else(|| Failure::refused(400, "meta must be JSON"))?;
        Ok(Self { meta, files })
    }
}

impl Exchange<'_> {
    /// The most a request may carry: a model and a little more.
    const MOST_BODY: usize = 340 * 1024 * 1024;

    /// The body's bytes, up to `most`: longer than that is refused before it is read, and the connection goes, for its
    /// bytes will never be read. No length is no body: a length that cannot be known was refused before any route. A
    /// body is read once: a second read would take the next request.
    pub fn read_body(&mut self, most: usize) -> Result<Vec<u8>, Failure> {
        if self.body_read {
            return Err(Failure::Internal("the body was read already".to_string()));
        }
        let size = match self.head.headers.content_length() {
            ContentLength::Bytes(size) => size,
            ContentLength::Unsaid | ContentLength::Other(_) => 0,
        };
        if size > most {
            return Err(Failure::Page(413));
        }
        let mut raw = Vec::with_capacity(size);
        (&mut *self.source).take(size as u64).read_to_end(&mut raw).map_err(|_| Failure::Page(400))?;
        if raw.len() < size {
            return Err(Failure::Page(400));
        }
        self.body_read = true;
        Ok(raw)
    }

    /// The JSON a request carries: none when it does not call itself JSON, or it does not parse.
    pub fn json_value(&mut self) -> Result<Option<Value>, Failure> {
        if !self.head.headers.says_json() {
            return Ok(None);
        }
        Ok(serde_json::from_slice(&self.read_body(Self::MOST_BODY)?).ok())
    }

    /// The JSON object the request carries: an empty one when it carries nothing, or something that is not JSON. JSON
    /// that is not an object (a list, a string, a number) is refused, because every route that reads a body reads fields
    /// from it, and a list has none.
    pub fn json_object(&mut self) -> Result<Map<String, Value>, Failure> {
        match self.json_value()? {
            None => Ok(Map::new()),
            Some(Value::Object(fields)) => Ok(fields),
            Some(_) => Err(Failure::refused(400, "the body must be a JSON object")),
        }
    }

    /// The bytes of an upload, and its boundary.
    pub fn upload_bytes(&mut self) -> Result<(Vec<u8>, Option<String>), Failure> {
        // absent-ok: a request that names no type has no boundary, and no meta is said of it.
        let kind = self.head.headers.get("Content-Type").unwrap_or_default();
        Ok((self.read_body(Self::MOST_BODY)?, Multipart::boundary_of(&kind)))
    }

    /// What an upload holds, of the bytes `upload_bytes` read.
    pub fn upload<'b>(body: &'b [u8], boundary: Option<&str>) -> Result<Upload<'b>, Failure> {
        Upload::read(body, boundary)
    }
}

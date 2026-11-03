//! One Copernicus file: a Cloud Optimized GeoTIFF, float32, 1024 x 1024 internal tiles compressed with deflate and the
//! floating-point predictor, and smaller copies of itself (overviews) inside the same file. A region reads only the
//! internal tiles it covers, by HTTP range requests.

use crate::fetcher::FetchError;
use files::StoreError;
use flate2::read::ZlibDecoder;
use std::collections::HashMap;
use std::fmt;
use std::io::Read as _;

/// Why a file gave no heights.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CogError {
    /// A file that cannot be read as these files are made: not a TIFF, cut short, a tag missing, a tile that does not
    /// inflate. A service that cannot be reached is `Fetch`, not this.
    Damaged(String),
    /// The service failed.
    Fetch(FetchError),
    /// The disk where pieces are kept.
    Store(StoreError),
}

impl fmt::Display for CogError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Damaged(words) => out.write_str(words),
            Self::Fetch(error) => write!(out, "{error}"),
            Self::Store(error) => write!(out, "{error}"),
        }
    }
}

impl From<FetchError> for CogError {
    fn from(error: FetchError) -> Self {
        Self::Fetch(error)
    }
}

impl From<StoreError> for CogError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// What reads a piece of the file: (start, length).
pub type Reader<'a> = dyn Fn(u64, u64) -> Result<Vec<u8>, CogError> + Sync + 'a;

/// A tag's values.
#[derive(Debug, Clone, PartialEq)]
enum TagValues {
    Whole(Vec<u64>),
    Float(Vec<f64>),
    Other,
}

/// One copy of the picture in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Level {
    width: u64,
    height: u64,
    tile_width: u64,
    tile_height: u64,
    offsets: Vec<u64>,
    counts: Vec<u64>,
    predictor: u64,
}

/// A piece of a level: its pixels, and where its first one lies.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    /// The column of its first pixel.
    pub x0: i64,
    /// The row of its first pixel.
    pub y0: i64,
    /// Pixels across.
    pub width: usize,
    /// Pixels down.
    pub height: usize,
    /// The pixels, row by row.
    pub pixels: Vec<f32>,
}

/// One file: its header read once, its internal tiles read when asked.
#[derive(Debug, Clone, PartialEq)]
pub struct CogFile {
    levels: Vec<Level>,
    /// The longitude of pixel (0, 0).
    pub lon0: f64,
    /// The latitude of pixel (0, 0).
    pub lat0: f64,
    /// Degrees of longitude a pixel.
    pub step_x: f64,
    /// Degrees of latitude a pixel.
    pub step_y: f64,
}

/// The bytes of the header read so far: more are read when they are needed, and how much is what names the pieces kept.
struct Head<'a> {
    bytes: Vec<u8>,
    reader: &'a Reader<'a>,
}

impl Head<'_> {
    fn cut_short() -> CogError {
        CogError::Damaged("the header of the file cannot be read (it ended too early)".to_string())
    }

    fn need(&mut self, at: u64, size: u64) -> Result<&[u8], CogError> {
        if size > CogFile::MOST_TABLE {
            return Err(CogError::Damaged("the header of the file cannot be read (a table too long)".to_string()));
        }
        let end = at + size;
        let have = self.bytes.len() as u64;
        if end > have {
            let more = (self.reader)(have, (end - have).max(CogFile::HEAD_BYTES))?;
            self.bytes.extend_from_slice(&more);
        }
        self.bytes.get(at as usize..end as usize).ok_or_else(Self::cut_short)
    }

    fn whole(bytes: &[u8]) -> u64 {
        bytes.iter().rev().fold(0, |value, byte| value << 8 | u64::from(*byte))
    }

    fn tag_values(&mut self, entry: &[u8]) -> Result<(u16, TagValues), CogError> {
        let field = |from: usize, to: usize| entry.get(from..to).map(Self::whole).ok_or_else(Self::cut_short);
        let (tag, kind, count) = (field(0, 2)?, field(2, 4)?, field(4, 8)?);
        let size = CogFile::type_size(kind) * count;
        let raw = if size <= 4 {
            entry.get(8..8 + size as usize).ok_or_else(Self::cut_short)?.to_vec()
        } else {
            let at = field(8, 12)?;
            self.need(at, size)?.to_vec()
        };
        let width = CogFile::type_size(kind) as usize;
        let values = match kind {
            3 | 4 | 16 => TagValues::Whole(raw.chunks(width).map(Self::whole).collect()),
            12 => TagValues::Float(raw.as_chunks::<8>().0.iter().map(|eight| f64::from_le_bytes(*eight)).collect()),
            _ => TagValues::Other,
        };
        Ok((tag as u16, values))
    }
}

impl CogFile {
    /// How much is read of a file at a time for its header.
    const HEAD_BYTES: u64 = 65536;
    /// The most bytes a table of its header may take, and the file is damaged past that: the real ones take some KB.
    const MOST_TABLE: u64 = 64 * 1024 * 1024;
    /// The most copies a file may hold; one that says more goes round in a circle.
    const MOST_LEVELS: usize = 32;
    /// The most pixels read at once: a real file has 3600 x 3600 and a request less.
    const MOST_WINDOW: u64 = 64_000_000;
    const IMAGE_WIDTH: u16 = 256;
    const IMAGE_HEIGHT: u16 = 257;
    const BITS: u16 = 258;
    const COMPRESSION: u16 = 259;
    const PREDICTOR: u16 = 317;
    const TILE_WIDTH: u16 = 322;
    const TILE_HEIGHT: u16 = 323;
    const TILE_OFFSETS: u16 = 324;
    const TILE_COUNTS: u16 = 325;
    const SAMPLE_FORMAT: u16 = 339;
    const PIXEL_SCALE: u16 = 33550;
    const TIE_POINT: u16 = 33922;
    const DEFLATE: u64 = 8;
    const FLOAT: u64 = 3;
    const FLOAT_PREDICTOR: u64 = 3;

    fn type_size(kind: u64) -> u64 {
        match kind {
            3 => 2,
            4 | 11 => 4,
            5 | 12 | 16 => 8,
            _ => 1,
        }
    }

    /// Reads the header. A file with a broken one is `Damaged`; a service that fails is not the file.
    pub fn open(reader: &Reader<'_>) -> Result<Self, CogError> {
        let mut head = Head { bytes: reader(0, Self::HEAD_BYTES)?, reader };
        if !head.bytes.starts_with(b"II*\0") {
            return Err(CogError::Damaged("not a little-endian TIFF".to_string()));
        }
        let mut offset = Head::whole(head.need(4, 4)?);
        let mut levels = Vec::new();
        let mut place = None;
        while offset != 0 {
            if levels.len() == Self::MOST_LEVELS {
                return Err(CogError::Damaged("the header of the file does not end".to_string()));
            }
            let count = Head::whole(head.need(offset, 2)?);
            let entries = head.need(offset + 2, 12 * count + 4)?.to_vec();
            let (table, next) = entries.split_at(12 * count as usize);
            let mut tags = HashMap::new();
            for entry in table.chunks(12) {
                let (tag, values) = head.tag_values(entry)?;
                tags.insert(tag, values);
            }
            levels.push(Self::level_of(&tags)?);
            if place.is_none() {
                place = Some(Self::place_of(&tags)?);
            }
            offset = Head::whole(next);
        }
        let Some((step_x, step_y, lon0, lat0)) = place else {
            return Err(CogError::Damaged("no image in the file".to_string()));
        };
        Ok(Self { levels, lon0, lat0, step_x, step_y })
    }

    fn missing(what: &str) -> CogError {
        CogError::Damaged(format!("the header of the file cannot be read (no {what})"))
    }

    fn first_of(tags: &HashMap<u16, TagValues>, tag: u16, otherwise: u64) -> u64 {
        match tags.get(&tag) {
            Some(TagValues::Whole(values)) => values.first().copied().unwrap_or(otherwise),
            _ => otherwise,
        }
    }

    fn needed(tags: &HashMap<u16, TagValues>, tag: u16) -> Result<u64, CogError> {
        match Self::first_of(tags, tag, 0) {
            0 => Err(Self::missing(&format!("tag {tag}"))),
            value => Ok(value),
        }
    }

    fn table(tags: &HashMap<u16, TagValues>, tag: u16) -> Result<Vec<u64>, CogError> {
        match tags.get(&tag) {
            Some(TagValues::Whole(values)) => Ok(values.clone()),
            _ => Err(Self::missing(&format!("tag {tag}"))),
        }
    }

    fn level_of(tags: &HashMap<u16, TagValues>) -> Result<Level, CogError> {
        if Self::first_of(tags, Self::COMPRESSION, 1) != Self::DEFLATE
            || Self::first_of(tags, Self::SAMPLE_FORMAT, 1) != Self::FLOAT
            || Self::first_of(tags, Self::BITS, 0) != 32
        {
            return Err(CogError::Damaged("expected float32 with deflate compression".to_string()));
        }
        Ok(Level {
            width: Self::needed(tags, Self::IMAGE_WIDTH)?,
            height: Self::needed(tags, Self::IMAGE_HEIGHT)?,
            tile_width: Self::needed(tags, Self::TILE_WIDTH)?,
            tile_height: Self::needed(tags, Self::TILE_HEIGHT)?,
            offsets: Self::table(tags, Self::TILE_OFFSETS)?,
            counts: Self::table(tags, Self::TILE_COUNTS)?,
            predictor: Self::first_of(tags, Self::PREDICTOR, 1),
        })
    }

    /// Degrees a pixel of longitude and latitude, and the point of pixel (0, 0).
    fn place_of(tags: &HashMap<u16, TagValues>) -> Result<(f64, f64, f64, f64), CogError> {
        let (Some(TagValues::Float(scale)), Some(TagValues::Float(tie))) =
            (tags.get(&Self::PIXEL_SCALE), tags.get(&Self::TIE_POINT))
        else {
            return Err(Self::missing("place on the map"));
        };
        match (scale.as_slice(), tie.as_slice()) {
            ([step_x, step_y, ..], [_, _, _, lon0, lat0, ..]) => Ok((*step_x, *step_y, *lon0, *lat0)),
            _ => Err(Self::missing("place on the map")),
        }
    }

    /// How many times smaller a level is than the whole picture.
    pub fn factor(&self, level: usize) -> f64 {
        match (self.levels.first(), self.levels.get(level)) {
            (Some(whole), Some(copy)) => whole.width as f64 / copy.width as f64,
            _ => 1.0,
        }
    }

    /// The smallest copy whose pixels are still as fine as `want` degrees of latitude.
    pub fn level_for(&self, want: f64) -> usize {
        let mut level = 0;
        while level + 1 < self.levels.len() && self.step_y * self.factor(level + 1) <= want {
            level += 1;
        }
        level
    }

    /// The heights of one internal tile from its inflated bytes.
    fn tile(&self, level: &Level, at: usize, tx: u64, ty: u64, reader: &Reader<'_>) -> Result<Vec<f32>, CogError> {
        let damaged = |why: &str| CogError::Damaged(format!("tile {tx},{ty} of level {at} cannot be read ({why})"));
        let across = level.width.div_ceil(level.tile_width);
        let k = (ty * across + tx) as usize;
        let (Some(offset), Some(count)) = (level.offsets.get(k), level.counts.get(k)) else {
            return Err(damaged("the file does not list it"));
        };
        let (width, height) = (level.tile_width as usize, level.tile_height as usize);
        let size = width * height * 4;
        let packed = reader(*offset, *count)?;
        let mut raw = Vec::with_capacity(size);
        ZlibDecoder::new(packed.as_slice())
            .take(size as u64 + 1)
            .read_to_end(&mut raw)
            .map_err(|error| damaged(&error.to_string()))?;
        if level.predictor == Self::FLOAT_PREDICTOR {
            let raw = raw.get(..size).ok_or_else(|| damaged("too few bytes"))?;
            Ok(Self::unpredict(raw, width))
        } else if raw.len() == size {
            Ok(raw.as_chunks::<4>().0.iter().map(|four| f32::from_le_bytes(*four)).collect())
        } else {
            Err(damaged("too few bytes"))
        }
    }

    /// The floating-point predictor (TIFF technical note 3) stores each row as byte differences, and the four bytes of
    /// each float in four runs, most significant first.
    fn unpredict(raw: &[u8], width: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(raw.len() / 4);
        for row in raw.chunks_exact(width * 4) {
            let mut sum = 0_u8;
            let bytes: Vec<u8> = row
                .iter()
                .map(|difference| {
                    sum = sum.wrapping_add(*difference);
                    sum
                })
                .collect();
            let (first, rest) = bytes.split_at(width);
            let (second, rest) = rest.split_at(width);
            let (third, fourth) = rest.split_at(width);
            out.extend(
                first
                    .iter()
                    .zip(second)
                    .zip(third)
                    .zip(fourth)
                    .map(|(((one, two), three), four)| f32::from_be_bytes([*one, *two, *three, *four])),
            );
        }
        out
    }

    /// Pixels x0..x1, y0..y1 (inclusive, clamped to the image) of a level.
    pub fn window(&self, at: usize, corners: [i64; 4], reader: &Reader<'_>) -> Result<Window, CogError> {
        let [x0, y0, x1, y1] = corners;
        let level = self.levels.get(at).ok_or_else(|| Self::missing("such level"))?;
        let (x0, x1) = (x0.max(0), x1.min(level.width as i64 - 1));
        let (y0, y1) = (y0.max(0), y1.min(level.height as i64 - 1));
        if x0 > x1 || y0 > y1 {
            return Err(CogError::Damaged("no pixel of the file lies in the region".to_string()));
        }
        let (width, height) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
        if (width as u64) * (height as u64) > Self::MOST_WINDOW {
            return Err(CogError::Damaged("the file says it is far bigger than these files are".to_string()));
        }
        let mut pixels = vec![0.0; width * height];
        let (tw, th) = (level.tile_width as i64, level.tile_height as i64);
        for ty in y0 / th..=y1 / th {
            for tx in x0 / tw..=x1 / tw {
                let tile = self.tile(level, at, tx as u64, ty as u64, reader)?;
                let box_of_tile = [tx * tw, ty * th, tw, th];
                Self::copy_tile(&tile, box_of_tile, &mut pixels, [x0, y0, x1, y1], width);
            }
        }
        Ok(Window { x0, y0, width, height, pixels })
    }

    /// Copies what a tile has of the window.
    fn copy_tile(tile: &[f32], tile_box: [i64; 4], pixels: &mut [f32], window: [i64; 4], width: usize) {
        let [left, top, tw, th] = tile_box;
        let [x0, y0, x1, y1] = window;
        let (ax0, ay0) = (x0.max(left), y0.max(top));
        let (ax1, ay1) = (x1.min(left + tw - 1), y1.min(top + th - 1));
        let across = (ax1 - ax0 + 1) as usize;
        for y in ay0..=ay1 {
            let from = ((y - top) * tw + (ax0 - left)) as usize;
            let to = (y - y0) as usize * width + (ax0 - x0) as usize;
            if let (Some(from), Some(to)) = (tile.get(from..from + across), pixels.get_mut(to..to + across)) {
                to.copy_from_slice(from);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_predictor_comes_undone() {
        // Two floats a row: their bytes in four runs, most significant first, each byte minus the one before it.
        let heights = [1234.5_f32, -400.25, 8848.0, 0.0];
        let mut raw = Vec::new();
        for row in heights.chunks(2) {
            let big: Vec<[u8; 4]> = row.iter().map(|value| value.to_be_bytes()).collect();
            let mut before = 0_u8;
            for plane in 0..4 {
                for float in &big {
                    raw.push(float[plane].wrapping_sub(before));
                    before = float[plane];
                }
            }
        }
        assert_eq!(CogFile::unpredict(&raw, 2), heights);
    }

    #[test]
    fn a_little_endian_number_of_any_size() {
        assert_eq!(Head::whole(&[1, 2]), 0x0201);
        assert_eq!(Head::whole(&[1, 0, 0, 0]), 1);
        assert_eq!(Head::whole(&[]), 0);
    }

    #[test]
    fn what_is_no_such_file() {
        let reader = |_: u64, _: u64| Ok(b"<html>try again</html>".to_vec());
        assert_eq!(CogFile::open(&reader), Err(CogError::Damaged("not a little-endian TIFF".to_string())));
        let reader = |_: u64, _: u64| Ok(b"II*\0".to_vec());
        assert!(matches!(CogFile::open(&reader), Err(CogError::Damaged(_))));
        let failing = |_: u64, _: u64| Err(CogError::Fetch(FetchError::of_status(500)));
        assert_eq!(CogFile::open(&failing), Err(CogError::Fetch(FetchError::of_status(500))));
    }

    #[test]
    fn a_header_that_points_at_itself_does_not_go_on_for_ever() {
        // A directory of no tags, whose next directory is itself, at byte 8.
        let mut file = b"II*\0\x08\0\0\0\0\0\x08\0\0\0".to_vec();
        file.resize(64, 0);
        let reader = move |start: u64, length: u64| {
            let start = (start as usize).min(file.len());
            let end = (start + length as usize).min(file.len());
            Ok(file[start..end].to_vec())
        };
        assert!(matches!(CogFile::open(&reader), Err(CogError::Damaged(_))));
    }
}

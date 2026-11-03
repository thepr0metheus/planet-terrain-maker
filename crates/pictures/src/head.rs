//! What a file says of itself: its kind and its size.

use std::fmt;
use std::io::Cursor;

/// A file that cannot be read as a picture: not a JPEG or a PNG, damaged, or more points than the server agrees to decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotAPicture;

impl fmt::Display for NotAPicture {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("not a readable JPEG or PNG picture")
    }
}

/// The two kinds of picture there are here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureKind {
    /// JPEG.
    Jpeg,
    /// PNG.
    Png,
}

/// A picture's kind and size, read from its first bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PictureHead {
    /// Its kind, by what the bytes say, whatever the file's name says.
    pub kind: PictureKind,
    /// Points across.
    pub width: usize,
    /// Points down.
    pub height: usize,
}

impl PictureHead {
    /// The most points a picture may have: Pillow's limit, which the server has always gone by. Its RGB takes 537 MB.
    const MOST_POINTS: u64 = 178_956_970;

    /// The head of these bytes.
    pub fn read(bytes: &[u8]) -> Result<Self, NotAPicture> {
        let head = if bytes.starts_with(b"\xff\xd8\xff") {
            Self::of_jpeg(bytes)?
        } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Self::of_png(bytes)?
        } else {
            return Err(NotAPicture);
        };
        if head.width as u64 * head.height as u64 > Self::MOST_POINTS { Err(NotAPicture) } else { Ok(head) }
    }

    fn of_jpeg(bytes: &[u8]) -> Result<Self, NotAPicture> {
        let mut decoder = jpeg_decoder::Decoder::new(bytes);
        decoder.read_info().map_err(|_| NotAPicture)?;
        let info = decoder.info().ok_or(NotAPicture)?;
        Ok(Self { kind: PictureKind::Jpeg, width: usize::from(info.width), height: usize::from(info.height) })
    }

    fn of_png(bytes: &[u8]) -> Result<Self, NotAPicture> {
        let reader = png::Decoder::new(Cursor::new(bytes)).read_info().map_err(|_| NotAPicture)?;
        let info = reader.info();
        Ok(Self { kind: PictureKind::Png, width: info.width as usize, height: info.height as usize })
    }
}

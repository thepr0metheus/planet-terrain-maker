//! A smaller copy of a model's picture, for devices that cannot hold the big ones. A picture of 8192 points a side is 67
//! million points: Safari on an iPad makes no canvas past 16.7 million, and decoding such a picture there gives a blank
//! one, so the model comes out black.

use crate::head::{NotAPicture, PictureHead, PictureKind};
use crate::rgb::Rgb;
use crate::shrink::Shrink;

/// The making of a copy.
pub struct SmallerCopy;

impl SmallerCopy {
    const QUALITY: u8 = 88;

    /// The JPEG of this picture at most `most` points a side; `None` when it is no bigger than that. Only then are its
    /// points read: a picture small enough is served as it is, even one damaged past its head.
    pub fn of(bytes: &[u8], most: usize) -> Result<Option<Vec<u8>>, NotAPicture> {
        let head = PictureHead::read(bytes)?;
        if head.width.max(head.height) <= most {
            return Ok(None);
        }
        // A JPEG is decoded smaller by a whole factor, and the copy's shape is taken from what that leaves.
        let factor = match head.kind {
            PictureKind::Jpeg => Shrink::draft_factor(head.width, head.height, most),
            PictureKind::Png => 1,
        };
        let picture = Rgb::read_smaller(bytes, &head, factor)?;
        let (width, height) = Shrink::fitting(picture.width, picture.height, most);
        Shrink::to_size(picture, width, height).to_jpeg(Self::QUALITY).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rgb::samples::{png, rgb};

    fn size_of(bytes: &[u8]) -> (usize, usize) {
        let head = PictureHead::read(bytes).unwrap();
        (head.width, head.height)
    }

    #[test]
    fn a_big_picture_comes_smaller_as_a_jpeg_and_a_small_one_does_not() {
        let jpeg = rgb(1200, 800, |_, _| [40, 120, 60]).to_jpeg(90).unwrap();
        let small = SmallerCopy::of(&jpeg, 300).unwrap().unwrap();
        assert_eq!(size_of(&small), (300, 200));
        assert_eq!(SmallerCopy::of(&jpeg, 1200).unwrap(), None);
        assert_eq!(SmallerCopy::of(&jpeg, 2000).unwrap(), None);
        let picture = png(800, 1200, png::ColorType::Grayscale, &vec![9; 800 * 1200]);
        let small = SmallerCopy::of(&picture, 300).unwrap().unwrap();
        assert_eq!(PictureHead::read(&small).unwrap().kind, PictureKind::Jpeg);
        assert_eq!(size_of(&small), (200, 300));
    }

    #[test]
    fn what_cannot_be_read_has_no_copy_but_what_is_small_enough_is_not_read() {
        let jpeg = rgb(640, 480, |x, y| [(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]).to_jpeg(90).unwrap();
        let cut = &jpeg[..jpeg.len() / 2];
        assert_eq!(SmallerCopy::of(cut, 64), Err(NotAPicture));
        assert_eq!(SmallerCopy::of(cut, 640), Ok(None));
        assert_eq!(SmallerCopy::of(b"hello", 64), Err(NotAPicture));
    }
}

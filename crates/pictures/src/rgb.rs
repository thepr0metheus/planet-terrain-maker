//! A picture's points, three bytes each.

use crate::head::{NotAPicture, PictureHead, PictureKind};
use jpeg_decoder::PixelFormat;
use jpeg_encoder::{ColorType, Encoder};
use std::io::Cursor;

/// Points as RGB, row by row from the top. Whatever else a picture holds, transparency too, is left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) points: Vec<u8>,
}

impl Rgb {
    /// A picture of a whole file. A file cut short is no picture.
    pub fn read(bytes: &[u8], head: &PictureHead) -> Result<Self, NotAPicture> {
        Self::read_smaller(bytes, head, 1)
    }

    /// As `read`, a JPEG decoded this many times smaller, 1, 2, 4 or 8: the decoder skips what it would only throw away.
    /// A PNG is read whole.
    pub(crate) fn read_smaller(bytes: &[u8], head: &PictureHead, factor: usize) -> Result<Self, NotAPicture> {
        let (width, height, points) = match head.kind {
            PictureKind::Jpeg => Self::jpeg_points(bytes, head, factor)?,
            PictureKind::Png => (head.width, head.height, Self::png_points(bytes)?),
        };
        if points.len() == width * height * 3 { Ok(Self { width, height, points }) } else { Err(NotAPicture) }
    }

    fn jpeg_points(bytes: &[u8], head: &PictureHead, factor: usize) -> Result<(usize, usize, Vec<u8>), NotAPicture> {
        let mut decoder = jpeg_decoder::Decoder::new(bytes);
        decoder.read_info().map_err(|_| NotAPicture)?;
        let side = |points: usize| u16::try_from(points.div_ceil(factor)).map_err(|_| NotAPicture);
        let (width, height) = decoder.scale(side(head.width)?, side(head.height)?).map_err(|_| NotAPicture)?;
        let samples = decoder.decode().map_err(|_| NotAPicture)?;
        let format = decoder.info().ok_or(NotAPicture)?.pixel_format;
        Ok((usize::from(width), usize::from(height), Self::jpeg_rgb(samples, format)))
    }

    fn jpeg_rgb(samples: Vec<u8>, format: PixelFormat) -> Vec<u8> {
        match format {
            PixelFormat::RGB24 => samples,
            PixelFormat::L8 => samples.iter().flat_map(|grey| [*grey; 3]).collect(),
            PixelFormat::L16 => samples.as_chunks::<2>().0.iter().flat_map(|[high, _]| [*high; 3]).collect(),
            PixelFormat::CMYK32 => samples.as_chunks::<4>().0.iter().flat_map(Self::rgb_of_cmyk).collect(),
        }
    }

    /// As Pillow turns CMYK into RGB.
    fn rgb_of_cmyk([c, m, y, k]: &[u8; 4]) -> [u8; 3] {
        let black = u32::from(255 - *k);
        [c, m, y].map(|ink| ((u32::from(255 - *ink) * black + 127) / 255) as u8)
    }

    fn png_points(bytes: &[u8]) -> Result<Vec<u8>, NotAPicture> {
        // The points are counted by `PictureHead`; what this limits is the decoder's own buffers.
        const BUFFERS: usize = 1 << 31;
        let mut decoder = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: BUFFERS });
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(|_| NotAPicture)?;
        let size = reader.output_buffer_size().ok_or(NotAPicture)?;
        let mut samples = vec![0; size];
        let frame = reader.next_frame(&mut samples).map_err(|_| NotAPicture)?;
        samples.truncate(frame.buffer_size());
        Ok(match frame.color_type {
            png::ColorType::Rgb => samples,
            png::ColorType::Rgba => samples.as_chunks::<4>().0.iter().flat_map(|[r, g, b, _]| [*r, *g, *b]).collect(),
            png::ColorType::Grayscale => samples.iter().flat_map(|grey| [*grey; 3]).collect(),
            png::ColorType::GrayscaleAlpha => {
                samples.as_chunks::<2>().0.iter().flat_map(|[grey, _]| [*grey; 3]).collect()
            }
            png::ColorType::Indexed => return Err(NotAPicture),
        })
    }

    /// Points across.
    pub fn width(&self) -> usize {
        self.width
    }

    /// Points down.
    pub fn height(&self) -> usize {
        self.height
    }

    /// As a JPEG of this quality, with the standard tables. Tables made for the picture would save a tenth of the bytes,
    /// but `zune-jpeg` read those of this encoder wrong, without a word: the copies go to devices whose decoder cannot
    /// be tried from here.
    pub fn to_jpeg(&self, quality: u8) -> Result<Vec<u8>, NotAPicture> {
        let (width, height) = (u16::try_from(self.width), u16::try_from(self.height));
        let (Ok(width), Ok(height)) = (width, height) else {
            return Err(NotAPicture);
        };
        let mut out = Vec::new();
        let encoder = Encoder::new(&mut out, quality);
        encoder.encode(&self.points, width, height, ColorType::Rgb).map_err(|_| NotAPicture)?;
        Ok(out)
    }
}

#[cfg(test)]
pub(crate) mod samples {
    //! Pictures to test with, made by the same packages.

    use super::*;

    pub(crate) fn rgb(width: usize, height: usize, point: impl Fn(usize, usize) -> [u8; 3]) -> Rgb {
        let points = (0..height).flat_map(|y| (0..width).map(move |x| (x, y))).flat_map(|(x, y)| point(x, y)).collect();
        Rgb { width, height, points }
    }

    pub(crate) fn png(width: u32, height: u32, color: png::ColorType, samples: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(samples).unwrap();
        writer.finish().unwrap();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::samples::*;
    use super::*;

    fn read(bytes: &[u8]) -> Result<Rgb, NotAPicture> {
        Rgb::read(bytes, &PictureHead::read(bytes)?)
    }

    #[test]
    fn a_jpeg_goes_there_and_back() {
        let picture = rgb(64, 48, |_, _| [200, 100, 50]);
        let bytes = picture.to_jpeg(90).unwrap();
        let head = PictureHead::read(&bytes).unwrap();
        assert_eq!((head.kind, head.width, head.height), (PictureKind::Jpeg, 64, 48));
        let back = read(&bytes).unwrap();
        for (one, other) in back.points.iter().zip(&picture.points) {
            assert!(one.abs_diff(*other) < 8, "{one} {other}");
        }
    }

    #[test]
    fn cmyk_comes_as_pillow_makes_it() {
        assert_eq!(Rgb::rgb_of_cmyk(&[0, 0, 0, 0]), [255, 255, 255]);
        assert_eq!(Rgb::rgb_of_cmyk(&[0, 0, 0, 255]), [0, 0, 0]);
        assert_eq!(Rgb::rgb_of_cmyk(&[55, 155, 205, 0]), [200, 100, 50]);
    }

    #[test]
    fn a_jpeg_is_decoded_smaller_when_asked() {
        let bytes = rgb(65, 48, |_, _| [200, 100, 50]).to_jpeg(90).unwrap();
        let head = PictureHead::read(&bytes).unwrap();
        for (factor, want) in [(1, (65, 48)), (2, (33, 24)), (4, (17, 12)), (8, (9, 6))] {
            let small = Rgb::read_smaller(&bytes, &head, factor).unwrap();
            assert_eq!((small.width, small.height), want, "{factor}");
            assert!(small.points.iter().step_by(3).all(|red| red.abs_diff(200) < 8));
        }
    }

    #[test]
    fn each_colour_type_of_a_png_comes_as_rgb() {
        for (color, samples, want) in [
            (png::ColorType::Rgb, vec![1, 2, 3], [1, 2, 3]),
            (png::ColorType::Rgba, vec![1, 2, 3, 0], [1, 2, 3]),
            (png::ColorType::Grayscale, vec![7], [7, 7, 7]),
            (png::ColorType::GrayscaleAlpha, vec![7, 0], [7, 7, 7]),
        ] {
            let bytes = png(1, 1, color, &samples);
            assert_eq!(PictureHead::read(&bytes).unwrap().kind, PictureKind::Png);
            assert_eq!(read(&bytes).unwrap().points, want, "{color:?}");
        }
    }

    #[test]
    fn what_is_no_picture() {
        let jpeg = rgb(640, 480, |x, y| [(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]).to_jpeg(90).unwrap();
        let png_bytes = png(2, 2, png::ColorType::Grayscale, &[1, 2, 3, 4]);
        for bytes in [&b""[..], b"hello", b"GIF89a", b"II*\0", b"\xff\xd8 not a jpeg", b"\x89PNG\r\n\x1a\n"] {
            assert_eq!(PictureHead::read(bytes), Err(NotAPicture), "{}", String::from_utf8_lossy(bytes));
        }
        assert_eq!(read(&jpeg[..jpeg.len() / 2]), Err(NotAPicture), "a JPEG cut short");
        assert_eq!(read(&png_bytes[..png_bytes.len() - 20]), Err(NotAPicture), "a PNG cut short");
    }

    #[test]
    fn a_picture_of_too_many_points_is_not_opened() {
        let mut head = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        head.extend_from_slice(&20000_u32.to_be_bytes());
        head.extend_from_slice(&20000_u32.to_be_bytes());
        head.extend_from_slice(&[8, 2, 0, 0, 0]);
        let crc = crc32fast_of(&head[12..]);
        head.extend_from_slice(&crc.to_be_bytes());
        head.extend_from_slice(b"\0\0\0\0IDAT\xae\x42\x60\x82");
        assert_eq!(PictureHead::read(&head), Err(NotAPicture));
    }

    /// The CRC a PNG chunk ends with.
    fn crc32fast_of(bytes: &[u8]) -> u32 {
        let mut crc = !0_u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
}

//! The shapes of what the page puts on a model at its real size: asteroids, comets and NASA's spacecraft. The page asks
//! for a shape by the list it comes from: the best known asteroid shapes (`web/data/asteroids-top.json`, made by
//! `tools/asteroids.py`), the comets seen up close (`comets.json`), NASA's models of spacecraft (the entries of
//! `vehicles.json` with an address; the others the page draws itself), or a model of the DAMIT catalogue by its number.
//! Only these lists can be asked for, so the server fetches nothing anyone names.

use crate::refused::Refused;
use serde_json::Value;
use std::collections::HashMap;

/// A kind of shape file: its type of content, and what it must hold.
#[derive(Debug, Clone, Copy)]
pub struct ShapeKind {
    /// The ending of a kept file.
    pub extension: &'static str,
    /// The type of content.
    pub content_type: &'static str,
    holds: fn(&[u8]) -> bool,
    /// What is wrong with a file that does not hold it.
    pub refusal: &'static str,
}

impl ShapeKind {
    /// The bytes of a file that are looked at.
    const HEAD: usize = 4096;
    /// The largest, Ceres's, is 9.5 MB.
    pub const MOST_BYTES: usize = 30 * 1024 * 1024;

    /// Every kind.
    pub const ALL: [Self; 4] = [
        Self {
            extension: "glb",
            content_type: "model/gltf-binary",
            holds: Self::holds_glb,
            refusal: "the file is not a GLB model",
        },
        Self {
            extension: "obj",
            content_type: "text/plain",
            holds: Self::holds_vertices,
            refusal: "the file holds no vertices",
        },
        Self {
            extension: "wrl",
            content_type: "text/plain",
            holds: Self::holds_vrml,
            refusal: "the file is no VRML shape",
        },
        Self {
            extension: "grid",
            content_type: "text/plain",
            holds: Self::holds_radii,
            refusal: "the file is no table of radii",
        },
    ];

    /// The kind a list calls this.
    pub fn named(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|kind| kind.extension == name)
    }

    /// The kind of a DAMIT model: vertices and facets.
    pub fn of_damit() -> Option<Self> {
        Self::named("obj")
    }

    /// Whether this file is the shape it should be; refused in words that say what is wrong.
    pub fn check(&self, body: &[u8]) -> Result<(), Refused> {
        if body.len() > Self::MOST_BYTES {
            return Err(Refused::new(format!(
                "the shape is {} MB, more than the {} MB a shape may be",
                body.len() / 1_000_000,
                Self::MOST_BYTES / 1_000_000
            )));
        }
        if (self.holds)(body.get(..Self::HEAD).unwrap_or(body)) { Ok(()) } else { Err(Refused::new(self.refusal)) }
    }

    fn holds_glb(head: &[u8]) -> bool {
        head.starts_with(b"glTF")
    }

    fn contains(head: &[u8], part: &[u8]) -> bool {
        head.windows(part.len()).any(|window| window == part)
    }

    /// A line that starts with `v` and a space or a tab.
    fn holds_vertices(head: &[u8]) -> bool {
        head.split(|byte| *byte == b'\n').any(|line| line.starts_with(b"v ") || line.starts_with(b"v\t"))
    }

    fn holds_vrml(head: &[u8]) -> bool {
        head.starts_with(b"#VRML") && Self::contains(head, b"point")
    }

    /// Its first line is three numbers.
    fn holds_radii(head: &[u8]) -> bool {
        let spaces = |at: usize| head.iter().skip(at).take_while(|byte| byte.is_ascii_whitespace()).count();
        let number = |at: usize| {
            head.iter().skip(at).take_while(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'.')).count()
        };
        let mut at = spaces(0);
        for piece in 0..3 {
            let length = number(at);
            if length == 0 {
                return false;
            }
            at += length;
            let gap = spaces(at);
            if piece < 2 && gap == 0 {
                return false;
            }
            at += gap;
            if piece == 2 {
                return head.iter().skip(at - gap).take(gap).any(|byte| *byte == b'\n');
            }
        }
        false
    }
}

/// One of the lists the page can ask from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShapeList {
    /// The best known asteroids.
    Top,
    /// The comets seen up close.
    Comets,
    /// NASA's spacecraft.
    Vehicles,
}

impl ShapeList {
    /// Every list.
    pub const ALL: [Self; 3] = [Self::Top, Self::Comets, Self::Vehicles];

    /// The name of its file in `web/data`.
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Top => "asteroids-top.json",
            Self::Comets => "comets.json",
            Self::Vehicles => "vehicles.json",
        }
    }

    /// How the names of its kept files start.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Comets => "comet",
            Self::Vehicles => "vehicle",
        }
    }
}

/// A shape of a list: where it lives, and what kind of file it is.
#[derive(Debug, Clone)]
pub struct ListedShape {
    /// Where it lives.
    pub url: String,
    /// The kind of its file.
    pub kind: ShapeKind,
}

/// The shapes of a list, by id. An entry without an address (a vehicle the page draws itself) is none the server gives.
#[derive(Debug, Clone, Default)]
pub struct ListedShapes {
    shapes: HashMap<String, ListedShape>,
}

impl ListedShapes {
    /// Reads a list's file. A kind nobody knows is refused: the list is the app's own, and made wrong.
    pub fn read(list: &Value) -> Result<Self, Refused> {
        let items = list.as_array().ok_or_else(|| Refused::new("the list is not a list"))?;
        let mut shapes = HashMap::new();
        for item in items {
            let Some(url) = item.get("url").and_then(Value::as_str).filter(|url| !url.is_empty()) else {
                continue;
            };
            let id = item.get("id").and_then(Value::as_str).ok_or_else(|| Refused::new(format!("{url} has no id")))?;
            let kind = item
                .get("kind")
                .and_then(Value::as_str)
                .and_then(ShapeKind::named)
                .ok_or_else(|| Refused::new(format!("{id} is of no known kind")))?;
            shapes.insert(id.to_string(), ListedShape { url: url.to_string(), kind });
        }
        Ok(Self { shapes })
    }

    /// The shape of this id.
    pub fn get(&self, id: &str) -> Option<&ListedShape> {
        self.shapes.get(id)
    }
}

/// A model of the DAMIT catalogue, by its number.
pub struct DamitShape;

impl DamitShape {
    const MOST: u64 = 10_000_000;

    /// Where the model lives; `None` for a number there is no model of.
    pub fn url(model: u64) -> Option<String> {
        (model > 0 && model < Self::MOST).then(|| {
            format!("https://damit.cuni.cz/projects/damit/generated_files/open/AsteroidModel/{model}/shape.obj")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(name: &str) -> ShapeKind {
        ShapeKind::named(name).unwrap()
    }

    #[test]
    fn each_kind_says_what_it_must_hold() {
        for (name, body, good) in [
            ("glb", &b"glTF\x02 a model"[..], true),
            ("glb", b"<html>", false),
            ("obj", b"v 1 2 3\nf 1 2 3\n", true),
            ("obj", b"# a comment\nv\t1 2 3\n", true),
            ("obj", b"<html>not a shape</html>", false),
            ("wrl", b"#VRML V2.0 utf8\nShape { point [ 0 0 0 ] }", true),
            ("wrl", b"#VRML V2.0 utf8\nnot what the list says", false),
            ("wrl", b"point", false),
            ("grid", b"  360  -90      8.800000\n  360  -85      8.800000\n", true),
            ("grid", b"1\n2\n3 \n4", true),
            ("grid", b"360 -90", false),
            ("grid", b"360 -90 8.8", false),
            ("grid", b"a b c\n", false),
            ("grid", b"", false),
        ] {
            assert_eq!(kind(name).check(body).is_ok(), good, "{name} {}", String::from_utf8_lossy(body));
        }
        assert!(kind("glb").check(&vec![b'g'; ShapeKind::MOST_BYTES + 1]).unwrap_err().0.contains("MB"));
    }

    #[test]
    fn a_list_is_read_and_what_has_no_address_is_left_out() {
        let shapes = ListedShapes::read(&json!([
            {"id": "bennu", "url": "https://x/b.glb", "kind": "glb"},
            {"id": "falcon-9", "name": "drawn by the page"},
        ]))
        .unwrap();
        assert_eq!(shapes.get("bennu").unwrap().url, "https://x/b.glb");
        assert!(shapes.get("falcon-9").is_none());
        assert!(ListedShapes::read(&json!([{"id": "a", "url": "https://x", "kind": "exe"}])).is_err());
        assert!(ListedShapes::read(&json!({"a": 1})).is_err());
    }

    #[test]
    fn the_numbers_of_damit() {
        assert!(DamitShape::url(0).is_none());
        assert!(DamitShape::url(10_000_000).is_none());
        assert!(DamitShape::url(101).unwrap().ends_with("/AsteroidModel/101/shape.obj"));
    }
}

//! Buildings of a region from OpenStreetMap, through the Overpass API: what is asked, and each one's outline and height
//! in its answer.

use crate::digest::Digest;
use crate::letters::Letters;
use crate::numbers::{Decimal, PyFloat};
use crate::percent::Percent;
use crate::py_text::PyText;
use crate::refused::Refused;
use crate::region::Region;
use serde_json::{Map, Value, json};

/// A question to Overpass about one region.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildingsQuestion {
    /// The name of the file its answer is kept in.
    pub file_name: String,
    /// The body of the request.
    pub form: String,
}

impl BuildingsQuestion {
    /// The servers, asked in turn. Overpass is run by volunteers on a few of them, and one is often busy.
    pub const MIRRORS: [&'static str; 4] = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ];
    /// A kept answer goes old after this: buildings change slowly, and a region is looked at again and again while its
    /// model is made.
    pub const KEEP_SECONDS: f64 = 30.0 * 24.0 * 3600.0;
    const MAX_SIDE_DEG: f64 = 0.1; // about 11 km of latitude: more is too much for Overpass and for a model

    /// The question about this region; refused when it is bigger than a model can show.
    pub fn of(region: &Region) -> Result<Self, Refused> {
        let Region { south, north, west, east } = *region;
        if north - south > Self::MAX_SIDE_DEG || east - west > Self::MAX_SIDE_DEG * 2.0 {
            return Err(Refused::new("Buildings are shown for regions up to about 10 km across."));
        }
        let corners = [south, west, north, east].map(|edge| PyFloat::fixed(edge, 5)).join(",");
        let digest = Digest::sha1_hex(corners.as_bytes());
        let query = format!(
            "[out:json][timeout:40];(way[\"building\"]({corners});relation[\"building\"][\"type\"=\"multipolygon\"]({corners}););out tags geom;"
        );
        Ok(Self {
            file_name: format!("{}.json", digest.get(..20).unwrap_or(&digest)),
            form: Percent::form(&[("data", query)]),
        })
    }
}

/// An answer of Overpass, read.
pub struct BuildingsAnswer;

impl BuildingsAnswer {
    const MAX_BUILDINGS: usize = 40000;
    const LEVEL_M: f64 = 3.0; // a storey
    const UNKNOWN_M: f64 = 6.0; // a building that says nothing about its height
    const CREDIT: &'static str = "© OpenStreetMap contributors (Overpass API)";
    const FOOT: f64 = 0.3048;

    /// `{buildings: [{ring: [[lon, lat], ...], height: metres}], cut: whether there were more, credit}`. Refused when
    /// Overpass says it failed, in words or by what it sent.
    pub fn read(data: &Value) -> Result<Value, Refused> {
        let fields = data.as_object().ok_or_else(|| Refused::new("Overpass sent no JSON object"))?;
        // absent-ok: no remark is no error said.
        let remark = fields.get("remark").map(PyText::of).unwrap_or_default();
        if remark.to_lowercase().contains("error") {
            return Err(Refused::new(format!("Overpass: {}", Letters::head(&remark, 200))));
        }
        let elements = fields.get("elements").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let found: Vec<Value> = elements.iter().filter_map(Value::as_object).flat_map(Self::buildings_of).collect();
        let cut = found.len() > Self::MAX_BUILDINGS;
        let kept: Vec<Value> = found.into_iter().take(Self::MAX_BUILDINGS).collect();
        Ok(json!({"buildings": kept, "cut": cut, "credit": Self::CREDIT}))
    }

    fn buildings_of(element: &Map<String, Value>) -> Vec<Value> {
        let tags = element.get("tags").and_then(Value::as_object);
        let Some(tags) = tags.filter(|tags| tags.get("building").is_some_and(|said| said != "no")) else {
            return Vec::new();
        };
        let height = PyFloat::round(Self::height_of(tags), 1);
        Self::rings(element).into_iter().map(|ring| json!({"ring": ring, "height": height})).collect()
    }

    /// Metres from the ground to the roof, from what the building's tags say.
    fn height_of(tags: &Map<String, Value>) -> f64 {
        // absent-ok: a tag not there says nothing of the height, and the next one is asked.
        let said = |name: &str| tags.get(name).map(PyText::of).unwrap_or_default();
        if let Some(height) = Self::metres(&said("height")).filter(|height| *height > 0.0 && *height < 1000.0) {
            return height;
        }
        match Decimal::read(&said("building:levels").replace(',', ".")) {
            Some(levels) if levels > 0.0 && levels < 300.0 => levels * Self::LEVEL_M + 1.0,
            _ => Self::UNKNOWN_M,
        }
    }

    /// What `height` says in metres: a number, and then `m`, `ft` or `'` or nothing. A comma is a point.
    fn metres(said: &str) -> Option<f64> {
        let said = Letters::strip(said).to_lowercase().replace(',', ".");
        let digits = said.bytes().take_while(|byte| byte.is_ascii_digit() || *byte == b'.').count();
        let (number, unit) = said.split_at(digits);
        if !Self::is_plain_decimal(number) {
            return None;
        }
        let value: f64 = number.parse().ok()?;
        match Letters::strip(unit) {
            "" | "m" => Some(value),
            "ft" | "'" => Some(value * Self::FOOT),
            _ => None,
        }
    }

    /// Digits, and at most one point with digits after it.
    fn is_plain_decimal(text: &str) -> bool {
        match text.split_once('.') {
            Some((whole, part)) => Letters::is_digits(whole) && Letters::is_digits(part),
            None => Letters::is_digits(text),
        }
    }

    /// The closed outer rings of a way or a multipolygon, as [[lon, lat], ...], without the point that closes each.
    fn rings(element: &Map<String, Value>) -> Vec<Vec<Value>> {
        let is_way = element.get("type").and_then(Value::as_str) == Some("way");
        let lines: Vec<&Value> = if is_way {
            element.get("geometry").into_iter().collect()
        } else {
            let members = element.get("members").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
            members
                .iter()
                .filter_map(Value::as_object)
                .filter(|member| member.get("role").and_then(Value::as_str) == Some("outer"))
                .filter_map(|member| member.get("geometry"))
                .collect()
        };
        lines.into_iter().filter_map(Self::ring).collect()
    }

    fn ring(line: &Value) -> Option<Vec<Value>> {
        let points: Vec<&Map<String, Value>> = line.as_array()?.iter().filter_map(Value::as_object).collect();
        let mut ring: Vec<Value> =
            points.iter().filter_map(|point| Some(json!([point.get("lon")?, point.get("lat")?]))).collect();
        if ring.len() < 4 || !Self::same_point(ring.first()?, ring.last()?) {
            return None;
        }
        ring.pop();
        Some(ring)
    }

    /// As numbers: `0` and `0.0` are one point, though JSON holds them apart.
    fn same_point(one: &Value, other: &Value) -> bool {
        let numbers = |point: &Value| -> Option<Vec<f64>> { point.as_array()?.iter().map(Value::as_f64).collect() };
        match (numbers(one), numbers(other)) {
            (Some(one), Some(other)) => one == other,
            _ => one == other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square() -> Value {
        json!([{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}, {"lat": 1, "lon": 1}, {"lat": 0.0, "lon": 0.0}])
    }

    #[test]
    fn heights_from_tags() {
        for (tags, want) in [
            (json!({"height": "12"}), 12.0),
            (json!({"height": "30'"}), 9.144),
            (json!({"height": "100 ft"}), 30.48),
            (json!({"height": "12,5 m"}), 12.5),
            (json!({"height": " 7 M "}), 7.0),
            (json!({"height": 12}), 12.0),
            (json!({"building:levels": "4"}), 13.0),
            (json!({"building:levels": "2,5"}), 8.5),
            (json!({"height": "tall"}), 6.0),
            (json!({"height": "1.2.3"}), 6.0),
            (json!({"height": ".5"}), 6.0),
            (json!({"height": "5."}), 6.0),
            (json!({}), 6.0),
            (json!({"height": "0"}), 6.0),
            (json!({"height": "1000"}), 6.0),
            (json!({"building:levels": "300"}), 6.0),
            (json!({"height": "tall", "building:levels": "1"}), 4.0),
        ] {
            let height = BuildingsAnswer::height_of(tags.as_object().unwrap());
            assert!((height - want).abs() < 1e-9, "{tags} {height}");
        }
    }

    #[test]
    fn outer_rings_only_and_open_lines_left_out() {
        let answer = json!({"elements": [
            {"type": "way", "tags": {"building": "yes", "height": "12 m"}, "geometry": square()},
            {"type": "relation", "tags": {"building": "yes", "building:levels": "4"}, "members": [
                {"role": "outer", "geometry": [{"lat": 2, "lon": 2}, {"lat": 2, "lon": 3}, {"lat": 3, "lon": 3}, {"lat": 2, "lon": 2}]},
                {"role": "inner", "geometry": square()}]},
            {"type": "way", "tags": {"highway": "path"}, "geometry": []},
            {"type": "way", "tags": {"building": "no"}, "geometry": square()},
            {"type": "way", "tags": {"building": "yes"}, "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}]},
            {"type": "way", "tags": {"building": "yes"}},
        ]});
        assert_eq!(
            BuildingsAnswer::read(&answer).unwrap(),
            json!({"buildings": [{"ring": [[0, 0], [1, 0], [1, 1]], "height": 12.0}, {"ring": [[2, 2], [3, 2], [3, 3]], "height": 13.0}],
                   "cut": false, "credit": "© OpenStreetMap contributors (Overpass API)"})
        );
    }

    #[test]
    fn a_remark_of_an_error_is_a_failure() {
        assert!(BuildingsAnswer::read(&json!({"remark": "runtime error: Query timed out", "elements": []})).is_err());
        assert!(BuildingsAnswer::read(&json!([1])).is_err());
        assert_eq!(BuildingsAnswer::read(&json!({"remark": "fine"})).unwrap()["buildings"], json!([]));
    }

    #[test]
    fn the_question_and_the_name_of_its_file() {
        let question = BuildingsQuestion::of(&Region { south: 41.6, north: 41.61, west: 41.6, east: 41.61 }).unwrap();
        assert_eq!(question.file_name, "4485baf900b37fbed6ad.json", "a name another version of this server finds too");
        assert!(question.form.starts_with("data=%5Bout%3Ajson%5D"));
        assert!(BuildingsQuestion::of(&Region { south: 40.0, north: 41.0, west: 40.0, east: 41.0 }).is_err());
        assert!(BuildingsQuestion::of(&Region { south: 40.0, north: 40.1, west: 40.0, east: 40.3 }).is_err());
    }
}

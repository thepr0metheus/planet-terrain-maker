//! Names of places on Earth, as Nominatim (OpenStreetMap) says them: what is asked and how its answers are read. Names
//! on the Moon, Mars and Venus need no server: the page carries the IAU's lists.

use crate::letters::Letters;
use crate::numbers::{Decimal, PyFloat};
use crate::percent::Percent;
use crate::py_text::PyText;
use serde_json::{Map, Value, json};

/// A question to Nominatim: its address, the words of its language, and the key its answer is kept under.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaceQuestion {
    /// The address.
    pub url: String,
    /// The value of `Accept-Language`.
    pub language: &'static str,
    /// What the answer is kept under.
    pub key: String,
    /// How the answer is read.
    pub reading: PlaceReading,
}

/// The two ways of reading an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceReading {
    /// A list of places.
    Search,
    /// One place, or none at sea.
    Reverse,
}

impl PlaceQuestion {
    const BASE: &'static str = "https://nominatim.openstreetmap.org";
    const LANGUAGES: [&'static str; 2] = ["ru", "en"];
    const MOST_QUERY: usize = 200;

    /// Up to 8 places whose names match. `None` when there is nothing to look for.
    pub fn search(query: &str, language: &str) -> Option<Self> {
        let collapsed = Letters::collapsed(query);
        let query = Letters::head(&collapsed, Self::MOST_QUERY);
        if query.is_empty() {
            return None;
        }
        let language = Self::language(language);
        let form = Percent::form(&[
            ("format", "jsonv2".to_string()),
            ("q", query.to_string()),
            ("limit", "8".to_string()),
            ("addressdetails", "0".to_string()),
        ]);
        Some(Self {
            url: format!("{}/search?{form}", Self::BASE),
            language,
            key: format!("search|{}|{language}", query.to_lowercase()),
            reading: PlaceReading::Search,
        })
    }

    /// The place at a point, at about the size of a town.
    pub fn reverse(lat: f64, lon: f64, language: &str) -> Self {
        let language = Self::language(language);
        let form = Percent::form(&[
            ("format", "jsonv2".to_string()),
            ("lat", PyFloat::fixed(lat, 5)),
            ("lon", PyFloat::fixed(lon, 5)),
            ("zoom", "10".to_string()),
            ("addressdetails", "0".to_string()),
        ]);
        Self {
            url: format!("{}/reverse?{form}", Self::BASE),
            language,
            key: format!("reverse|{}|{}|{language}", PyFloat::round(lat, 3), PyFloat::round(lon, 3)),
            reading: PlaceReading::Reverse,
        }
    }

    fn language(asked: &str) -> &'static str {
        Self::LANGUAGES.iter().copied().find(|known| *known == asked).unwrap_or("en")
    }

    /// What the answer says, as the page gets it.
    pub fn read(&self, found: &Value) -> Value {
        match self.reading {
            PlaceReading::Search => Self::places(found),
            PlaceReading::Reverse => Self::place_at(found),
        }
    }

    fn text_of<'a>(item: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
        item.get(name).and_then(Value::as_str)
    }

    /// The first name and the rest of the address, at most three of its parts.
    fn split_name(display: &str, name: Option<&str>) -> (String, String) {
        let parts: Vec<&str> = display.split(',').map(Letters::strip).filter(|part| !part.is_empty()).collect();
        // absent-ok: a place with no name and no address is named nothing, as Nominatim gave it.
        let first = name.filter(|name| !name.is_empty()).or_else(|| parts.first().copied()).unwrap_or("");
        let rest: Vec<&str> = parts.iter().copied().filter(|part| *part != first).take(3).collect();
        (first.to_string(), rest.join(", "))
    }

    fn places(found: &Value) -> Value {
        let items = found.as_array().map_or(&[][..], Vec::as_slice);
        Value::Array(items.iter().filter_map(|item| item.as_object().and_then(Self::place)).collect())
    }

    /// A place of a list; a place with no point is left out.
    fn place(item: &Map<String, Value>) -> Option<Value> {
        let lat = item.get("lat").and_then(Decimal::of_value)?;
        let lon = item.get("lon").and_then(Decimal::of_value)?;
        // absent-ok: a place without a full name has only what `name` says.
        let display = Self::text_of(item, "display_name").unwrap_or_default();
        let (name, detail) = Self::split_name(display, Self::text_of(item, "name"));
        let kind = item.get("type").filter(|kind| PyText::is_something(kind)).or_else(|| item.get("category"));
        // absent-ok: a place of no type and no category is of none, as Nominatim gave it.
        let kind = kind.cloned().unwrap_or(Value::Null);
        let mut place = json!({"name": name, "detail": detail, "lat": lat, "lon": lon, "kind": kind});
        if let (Some(box_of), Some(fields)) = (Self::box_of(item), place.as_object_mut()) {
            fields.insert("box".to_string(), box_of);
        }
        Some(place)
    }

    /// South, north, west and east, when Nominatim gives them, all four of them as numbers.
    fn box_of(item: &Map<String, Value>) -> Option<Value> {
        let edges = item.get("boundingbox")?.as_array().filter(|edges| edges.len() == 4)?;
        let numbers: Option<Vec<f64>> = edges.iter().map(Decimal::of_value).collect();
        numbers.map(|numbers| json!(numbers))
    }

    fn place_at(found: &Value) -> Value {
        let Some(item) = found.as_object().filter(|item| !item.contains_key("error")) else {
            return Value::Null;
        };
        let Some(display) = Self::text_of(item, "display_name").filter(|display| !display.is_empty()) else {
            return Value::Null;
        };
        let (name, detail) = Self::split_name(display, Self::text_of(item, "name"));
        json!({"name": name, "detail": detail})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_search_is_asked_and_kept_without_its_case_and_spaces() {
        let question = PlaceQuestion::search("  Batumi  x ", "ru").unwrap();
        assert_eq!(
            question.url,
            "https://nominatim.openstreetmap.org/search?format=jsonv2&q=Batumi+x&limit=8&addressdetails=0"
        );
        assert_eq!(question.language, "ru");
        assert_eq!(question.key, PlaceQuestion::search("batumi x", "ru").unwrap().key);
        assert!(PlaceQuestion::search("   ", "ru").is_none());
        assert_eq!(PlaceQuestion::search("a", "fr").unwrap().language, "en");
    }

    #[test]
    fn a_point_is_kept_to_a_thousandth_of_a_degree() {
        let question = PlaceQuestion::reverse(41.64, 41.63, "ru");
        assert_eq!(
            question.url,
            "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=41.64000&lon=41.63000&zoom=10&addressdetails=0"
        );
        assert_eq!(question.key, PlaceQuestion::reverse(41.6401, 41.6299, "ru").key);
        assert_ne!(question.key, PlaceQuestion::reverse(41.65, 41.63, "ru").key);
    }

    #[test]
    fn a_list_of_places_is_read() {
        let question = PlaceQuestion::search("a", "en").unwrap();
        let found = json!([
            {"lat": "41.64", "lon": "41.63", "name": "Batumi", "display_name": "Batumi, Adjara, Georgia", "type": "city", "boundingbox": ["41.6", "41.7", "41.5", "41.7"]},
            {"lat": "1", "lon": "2", "display_name": "Sea, Coast, Land, Earth, Far"},
            {"lat": "x", "lon": "2", "name": "no point"},
            {"name": "no point at all"},
            "not a place",
            {"lat": "3", "lon": "4", "category": "place", "name": "Only", "boundingbox": ["1", "x", "2", "3"]},
            {"lat": "5", "lon": "6", "name": "Short box", "boundingbox": ["1", "2"]},
        ]);
        assert_eq!(
            question.read(&found),
            json!([
                {"name": "Batumi", "detail": "Adjara, Georgia", "lat": 41.64, "lon": 41.63, "kind": "city", "box": [41.6, 41.7, 41.5, 41.7]},
                {"name": "Sea", "detail": "Coast, Land, Earth", "lat": 1.0, "lon": 2.0, "kind": null},
                {"name": "Only", "detail": "", "lat": 3.0, "lon": 4.0, "kind": "place"},
                {"name": "Short box", "detail": "", "lat": 5.0, "lon": 6.0, "kind": null},
            ])
        );
        assert_eq!(question.read(&json!({"not": "a list"})), json!([]));
    }

    #[test]
    fn a_place_at_a_point_or_none_at_sea() {
        let question = PlaceQuestion::reverse(0.0, 0.0, "en");
        assert_eq!(
            question.read(&json!({"name": "Batumi", "display_name": "Batumi, Adjara, Georgia"})),
            json!({"name": "Batumi", "detail": "Adjara, Georgia"})
        );
        assert_eq!(question.read(&json!({"error": "Unable to geocode"})), Value::Null);
        assert_eq!(question.read(&json!({"name": "x"})), Value::Null);
        assert_eq!(question.read(&json!([1])), Value::Null);
    }
}

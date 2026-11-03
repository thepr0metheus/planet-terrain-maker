//! What a saved model may be: its id, the names of its files, its limits. What a model means is the page's business:
//! the server checks names and sizes, and keeps the rest as it came, fields it does not know included.

use crate::json_form::JsonForm;
use crate::letters::Letters;
use crate::py_text::PyText;
use crate::refused::Refused;
use serde_json::{Map, Value};

/// The rules of a saved model.
pub struct ModelMeta;

impl ModelMeta {
    const MAX_FILE: usize = 96 * 1024 * 1024;
    const MAX_TOTAL: usize = 320 * 1024 * 1024;
    const MAX_FILES: usize = 16;
    const MAX_META: usize = 512 * 1024;
    const MAX_NAME: usize = 120;
    const ID_LENGTH: usize = 12;
    const MOST_STEM: usize = 41;
    const ENDINGS: [&'static str; 3] = ["bin", "jpg", "png"];
    /// A removed model leaves the trash after this many days.
    pub const TRASH_DAYS: f64 = 30.0;

    /// Twelve small hex digits.
    pub fn is_id(id: &str) -> bool {
        id.len() == Self::ID_LENGTH && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }

    /// A name a file of a model may have: `place-0.bin`, `thumb.jpg`.
    pub fn is_file_name(name: &str) -> bool {
        let Some((stem, ending)) = name.split_once('.') else {
            return false;
        };
        let small = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        Self::ENDINGS.contains(&ending)
            && stem.len() <= Self::MOST_STEM
            && stem.bytes().next().is_some_and(small)
            && stem.bytes().all(|byte| small(byte) || byte == b'-')
    }

    /// The name of a model or of a place: its words with one space between them, at most `MAX_NAME` letters. What
    /// counts as nothing, or has no words, is no name.
    pub fn name(name: &Value) -> Result<String, Refused> {
        let text = if PyText::is_something(name) { PyText::of(name) } else { String::new() };
        let collapsed = Letters::collapsed(&text);
        if collapsed.is_empty() {
            return Err(Refused::new("A model needs a name."));
        }
        Ok(Letters::head(&collapsed, Self::MAX_NAME).to_string())
    }

    /// Whether these limits let a model be kept, and its meta as it is then written: its name made clean, and the sizes
    /// of its files added, by name. `files` holds each file's name and size.
    pub fn checked(meta: &Value, files: &[(String, usize)]) -> Result<Map<String, Value>, Refused> {
        let Some(fields) = meta.as_object() else {
            return Err(Refused::new("meta must be a JSON object."));
        };
        if Letters::len(&JsonForm::ASCII.write(meta)) > Self::MAX_META {
            return Err(Refused::new(format!("meta is over {} KB.", Self::MAX_META / 1024)));
        }
        if files.len() > Self::MAX_FILES {
            return Err(Refused::new(format!("At most {} files a model.", Self::MAX_FILES)));
        }
        Self::check_files(files)?;
        let mut fields = fields.clone();
        let name = Self::name(fields.get("name").unwrap_or(&Value::Null))?;
        fields.insert("name".to_string(), Value::String(name));
        let mut sizes: Vec<&(String, usize)> = files.iter().collect();
        sizes.sort();
        let sizes: Map<String, Value> = sizes.iter().map(|(name, size)| (name.clone(), Value::from(*size))).collect();
        fields.insert("files".to_string(), Value::Object(sizes));
        Ok(fields)
    }

    fn check_files(files: &[(String, usize)]) -> Result<(), Refused> {
        let mut total = 0;
        for (name, size) in files {
            if !Self::is_file_name(name) {
                return Err(Refused::new(format!("A file may not be called {}.", PyText::repr(name))));
            }
            if *size > Self::MAX_FILE {
                return Err(Refused::new(format!("{name} is over {} MB.", Self::MAX_FILE / (1024 * 1024))));
            }
            total += size;
        }
        if total > Self::MAX_TOTAL {
            return Err(Refused::new(format!("The files are over {} MB together.", Self::MAX_TOTAL / (1024 * 1024))));
        }
        Ok(())
    }

    /// A model with a new name and, when `places` is given, a name for each of its places.
    pub fn renamed(meta: &Value, name: &Value, places: Option<&Value>) -> Result<Value, Refused> {
        let mut meta = meta.clone();
        let fields = meta.as_object_mut().ok_or_else(|| Refused::new("meta must be a JSON object."))?;
        fields.insert("name".to_string(), Value::String(Self::name(name)?));
        if let Some(new_names) = places.filter(|places| !places.is_null()) {
            Self::rename_places(fields, new_names)?;
        }
        Ok(meta)
    }

    fn rename_places(fields: &mut Map<String, Value>, new_names: &Value) -> Result<(), Refused> {
        let refusal = || Refused::new("places must give a name for each place of the model.");
        let new_names = new_names.as_array().ok_or_else(refusal)?;
        let empty = Vec::new();
        // absent-ok: a model with no places has none to name, and a list of no names fits it.
        let places = fields.get("places").and_then(Value::as_array).unwrap_or(&empty);
        if places.len() != new_names.len() {
            return Err(refusal());
        }
        let mut renamed = Vec::with_capacity(places.len());
        for (place, new_name) in places.iter().zip(new_names) {
            let mut place = place.clone();
            let place_fields = place.as_object_mut().ok_or_else(refusal)?;
            place_fields.insert("name".to_string(), Value::String(Self::name(new_name)?));
            renamed.push(place);
        }
        if fields.contains_key("places") {
            fields.insert("places".to_string(), Value::Array(renamed));
        }
        Ok(())
    }

    /// What the list of models says of one: its id, name, times, worlds, places and files. `None` for a meta with no id.
    pub fn listed(meta: &Value) -> Option<Value> {
        let fields = meta.as_object()?;
        let id = fields.get("id")?.clone();
        // absent-ok: a field a model does not have is null in the list, as it always was.
        let or_null = |name: &str| fields.get(name).cloned().unwrap_or(Value::Null);
        let places: Vec<Value> = fields
            .get("places")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|place| {
                let name = place.get("name").cloned().unwrap_or_else(|| Value::from(""));
                // absent-ok: as above.
                let world = place.get("world").cloned().unwrap_or(Value::Null);
                serde_json::json!({"name": name, "world": world})
            })
            .collect();
        let files = fields.get("files").and_then(Value::as_object);
        // absent-ok: a model with no files lists none.
        let mut files: Vec<&String> = files.map_or(Vec::new(), |files| files.keys().collect());
        files.sort();
        Some(serde_json::json!({
            "id": id,
            "name": fields.get("name").cloned().unwrap_or_else(|| Value::from("")),
            "created": or_null("created"),
            "updated": or_null("updated"),
            "worlds": fields.get("worlds").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "places": places,
            "files": files,
        }))
    }

    /// When a model was last changed, for the order of the list; "" when its meta does not say.
    pub fn updated_of(listed: &Value) -> &str {
        // absent-ok: a model that does not say when it changed goes last, as it always did.
        listed.get("updated").and_then(Value::as_str).unwrap_or_default()
    }

    /// The day a folder in the trash was put there, from its name: `<id>-<seconds>`.
    pub fn trashed_at(folder: &str) -> Option<f64> {
        let (_, stamp) = folder.rsplit_once('-')?;
        Letters::is_digits(stamp).then(|| stamp.parse().ok()).flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids() {
        assert!(ModelMeta::is_id("0123456789ab"));
        for bad in ["", "x", "ABCDEF123456", "../../etc", "0123456789ab\n", "0123456789abc", "0123456789a٣"] {
            assert!(!ModelMeta::is_id(bad), "{bad}");
        }
    }

    #[test]
    fn names_of_files() {
        for good in ["place-0.bin", "thumb.jpg", "a.png", "0-.bin"] {
            assert!(ModelMeta::is_file_name(good), "{good}");
        }
        let long = format!("{}.bin", "a".repeat(42));
        for bad in ["../evil.bin", "Place.BIN", "a.exe", "-a.bin", ".bin", "a", "a.bin\n", "a.b.bin", &long] {
            assert!(!ModelMeta::is_file_name(bad), "{bad}");
        }
        assert!(ModelMeta::is_file_name(&format!("{}.bin", "a".repeat(41))));
    }

    #[test]
    fn a_name_has_words_and_a_limit_in_letters() {
        assert_eq!(ModelMeta::name(&json!("  Batumi  and   Elbrus ")).unwrap(), "Batumi and Elbrus");
        assert_eq!(ModelMeta::name(&json!("ა".repeat(200))).unwrap(), "ა".repeat(120));
        assert_eq!(ModelMeta::name(&json!(5)).unwrap(), "5");
        assert_eq!(ModelMeta::name(&json!(1.5)).unwrap(), "1.5");
        for nothing in [json!(null), json!(""), json!("   "), json!(0), json!(false), json!([])] {
            assert!(ModelMeta::name(&nothing).is_err(), "{nothing}");
        }
    }

    #[test]
    fn what_is_kept_keeps_its_order_and_its_fields() {
        let meta = json!({"z": 1, "name": " a ", "b": {"c": [1, 2.5]}});
        let kept = ModelMeta::checked(&meta, &[("b.bin".to_string(), 2), ("a.bin".to_string(), 1)]).unwrap();
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["z", "name", "b", "files"]);
        assert_eq!(kept["name"], "a");
        assert_eq!(kept["files"].as_object().unwrap().keys().collect::<Vec<_>>(), ["a.bin", "b.bin"]);
    }

    #[test]
    fn what_cannot_be_kept() {
        let name = json!({"name": "x"});
        let refusal = |meta: &Value, files: &[(String, usize)]| ModelMeta::checked(meta, files).unwrap_err().0;
        assert_eq!(refusal(&json!(["a"]), &[]), "meta must be a JSON object.");
        assert_eq!(refusal(&json!({"name": " "}), &[]), "A model needs a name.");
        assert_eq!(refusal(&json!({"name": "x", "a": "b".repeat(600 * 1024)}), &[]), "meta is over 512 KB.");
        let many: Vec<(String, usize)> = (0..17).map(|at| (format!("p-{at}.bin"), 0)).collect();
        assert_eq!(refusal(&name, &many), "At most 16 files a model.");
        assert_eq!(refusal(&name, &[("../a".to_string(), 0)]), "A file may not be called '../a'.");
        assert_eq!(refusal(&name, &[("a.bin".to_string(), 97 * 1024 * 1024)]), "a.bin is over 96 MB.");
        let big: Vec<(String, usize)> = (0..4).map(|at| (format!("p-{at}.bin"), 90 * 1024 * 1024)).collect();
        assert_eq!(refusal(&name, &big), "The files are over 320 MB together.");
    }

    #[test]
    fn a_model_and_its_places_are_renamed_or_nothing_is() {
        let meta = json!({"name": "a", "places": [{"name": "p", "world": "earth"}, {"name": "q"}], "other": 1});
        let renamed = ModelMeta::renamed(&meta, &json!("b"), Some(&json!(["P", "Q"]))).unwrap();
        assert_eq!(renamed["name"], "b");
        assert_eq!(renamed["places"], json!([{"name": "P", "world": "earth"}, {"name": "Q"}]));
        assert_eq!(renamed["other"], 1);
        for wrong in [json!(["one"]), json!(["a", " "]), json!("Batumi")] {
            assert!(ModelMeta::renamed(&meta, &json!("b"), Some(&wrong)).is_err(), "{wrong}");
        }
        assert!(
            ModelMeta::renamed(&json!({"name": "a"}), &json!("b"), Some(&json!([]))).is_ok(),
            "no places: none to name"
        );
        assert!(ModelMeta::renamed(&meta, &json!("b"), Some(&Value::Null)).is_ok(), "null is no places");
    }

    #[test]
    fn a_line_of_the_list() {
        let meta = json!({"id": "a", "name": "n", "created": "c", "updated": "u", "worlds": ["earth"], "settings": {},
                          "places": [{"name": "p", "world": "w", "x": 1}, {}], "files": {"b.bin": 1, "a.bin": 2}});
        assert_eq!(
            ModelMeta::listed(&meta).unwrap(),
            json!({"id": "a", "name": "n", "created": "c", "updated": "u", "worlds": ["earth"],
                   "places": [{"name": "p", "world": "w"}, {"name": "", "world": null}], "files": ["a.bin", "b.bin"]})
        );
        assert!(ModelMeta::listed(&json!({"name": "no id"})).is_none());
        assert!(ModelMeta::listed(&json!([1])).is_none());
        assert_eq!(ModelMeta::updated_of(&json!({"updated": 5})), "");
    }

    #[test]
    fn the_day_in_the_name_of_a_folder_in_the_trash() {
        assert_eq!(ModelMeta::trashed_at("0123456789ab-1790000000"), Some(1_790_000_000.0));
        assert_eq!(ModelMeta::trashed_at("not-a-stamp"), None);
        assert_eq!(ModelMeta::trashed_at("nostamp"), None);
    }
}

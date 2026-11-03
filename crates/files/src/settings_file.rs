//! The settings' file: `data/settings.json`. A setting nobody here knows stays in it as it is.

use crate::atomic::AtomicFile;
use crate::json_file::JsonRead;
use crate::locked::Locked;
use crate::log::Log;
use crate::random::Random;
use crate::store_error::StoreError;
use rules::settings::SettingRules;
use rules::{JsonForm, Refused};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::PathBuf;

/// Why a setting was not kept.
#[derive(Debug, PartialEq, Eq)]
pub enum SettingsError {
    /// A setting that cannot be.
    Refused(Refused),
    /// The disk.
    Store(StoreError),
}

impl From<StoreError> for SettingsError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<Refused> for SettingsError {
    fn from(refused: Refused) -> Self {
        Self::Refused(refused)
    }
}

/// The file, and the one writer it has.
pub struct SettingsFile {
    path: PathBuf,
    log: Log,
    writing: Locked<()>,
}

impl SettingsFile {
    /// The file at this path.
    pub fn new(path: PathBuf, log: Log) -> Self {
        Self { path, log, writing: Locked::new(()) }
    }

    /// What it holds. A file that is broken reads as no settings, and the log says so: the page opens with its own.
    fn read(&self) -> Result<Map<String, Value>, StoreError> {
        match JsonRead::of(&self.path)? {
            JsonRead::Absent => Ok(Map::new()),
            JsonRead::Value(Value::Object(fields)) => Ok(fields),
            JsonRead::Value(_) | JsonRead::Broken => {
                self.log.say(&format!("settings: {} is no table of settings, and reads as none", self.path.display()));
                Ok(Map::new())
            }
        }
    }

    /// What it holds, for a write. A file that is broken is put aside first, not written over: whatever it held is kept,
    /// and the log says where.
    fn read_for_writing(&self) -> Result<Map<String, Value>, StoreError> {
        match JsonRead::of(&self.path)? {
            JsonRead::Absent => Ok(Map::new()),
            JsonRead::Value(Value::Object(fields)) => Ok(fields),
            JsonRead::Value(_) | JsonRead::Broken => {
                let aside = self.path.with_file_name(format!("settings.json.broken-{}", Random::hex(3)?));
                fs::rename(&self.path, &aside)?;
                self.log.say(&format!(
                    "settings: {} was no table of settings: kept as {}",
                    self.path.display(),
                    aside.display()
                ));
                Ok(Map::new())
            }
        }
    }

    fn write(&self, settings: Map<String, Value>) -> Result<(), StoreError> {
        let text = JsonForm::ASCII_FILE.write(&Value::Object(settings));
        AtomicFile::write(&self.path, text.as_bytes(), AtomicFile::OPEN)?;
        Ok(())
    }

    /// `{world: {lat, lon, zoom}}` for the worlds that have their own start.
    pub fn starts(&self) -> Result<Value, StoreError> {
        Ok(SettingRules::starts_of(&Value::Object(self.read()?)))
    }

    /// The set of flight speeds of your own, or null.
    pub fn fly_preset(&self) -> Result<Value, StoreError> {
        Ok(SettingRules::fly_preset_of(&Value::Object(self.read()?)))
    }

    /// Keeps where a world's map opens, and gives it back as it was kept.
    pub fn set_start(
        &self,
        world: &str,
        lat: Option<&Value>,
        lon: Option<&Value>,
        zoom: Option<&Value>,
    ) -> Result<Value, SettingsError> {
        let start = SettingRules::start(world, lat, lon, zoom)?;
        self.writing.with(|()| {
            let mut settings = self.read_for_writing()?;
            let starts = settings.entry("starts").or_insert_with(|| json!({}));
            if !starts.is_object() {
                *starts = json!({});
            }
            if let Some(starts) = starts.as_object_mut() {
                starts.insert(world.to_string(), start.clone());
            }
            self.write(settings)
        })?;
        Ok(start)
    }

    /// Keeps a set of flight speeds, and gives it back as it was kept.
    pub fn set_fly_preset(&self, rates: Option<&Value>) -> Result<Value, SettingsError> {
        let preset = SettingRules::fly_preset(rates)?;
        self.writing.with(|()| {
            let mut settings = self.read_for_writing()?;
            settings.insert("fly_preset".to_string(), preset.clone());
            self.write(settings)
        })?;
        Ok(preset)
    }

    /// Forgets where a world's map opens.
    pub fn clear_start(&self, world: &str) -> Result<(), SettingsError> {
        SettingRules::check_world(world)?;
        self.writing.with(|()| {
            let mut settings = self.read()?;
            let had =
                settings.get_mut("starts").and_then(Value::as_object_mut).and_then(|starts| starts.shift_remove(world));
            if had.is_some() { self.write(settings) } else { Ok(()) }
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::StillClock;
    use std::fs;
    use std::sync::Arc;

    fn file(name: &str) -> SettingsFile {
        let root = std::env::temp_dir().join(format!("ptm-settings-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        SettingsFile::new(root.join("settings.json"), Log::new(Arc::new(StillClock::at(0.0))))
    }

    #[test]
    fn it_is_written_as_it_always_was_and_keeps_what_nobody_knows() {
        let settings = file("written");
        fs::create_dir_all(settings.path.parent().unwrap()).unwrap();
        fs::write(&settings.path, r#"{"later": {"a": "ა"}, "starts": {"pluto": {"lat": 1}}}"#).unwrap();
        let (lat, lon, zoom) = (json!(1.5), json!(2), json!(3));
        settings.set_start("moon", Some(&lat), Some(&lon), Some(&zoom)).unwrap();
        assert_eq!(
            fs::read_to_string(&settings.path).unwrap(),
            "{\n \"later\": {\n  \"a\": \"\\u10d0\"\n },\n \"starts\": {\n  \"pluto\": {\n   \"lat\": 1\n  },\n  \"moon\": {\n   \"lat\": 1.5,\n   \"lon\": 2.0,\n   \"zoom\": 3.0\n  }\n }\n}"
        );
        settings.clear_start("pluto").unwrap_err();
        settings.clear_start("moon").unwrap();
        assert_eq!(settings.starts().unwrap(), json!({}));
    }

    #[test]
    fn a_broken_file_reads_as_no_settings() {
        let settings = file("broken");
        assert_eq!(settings.starts().unwrap(), json!({}));
        assert_eq!(settings.fly_preset().unwrap(), Value::Null);
        fs::create_dir_all(settings.path.parent().unwrap()).unwrap();
        for broken in ["{broken", "[1, 2]", "\u{7f}"] {
            fs::write(&settings.path, broken).unwrap();
            assert_eq!(settings.starts().unwrap(), json!({}), "{broken}");
        }
    }

    #[test]
    fn a_broken_file_is_put_aside_before_a_setting_is_written() {
        let settings = file("aside");
        let folder = settings.path.parent().unwrap().to_path_buf();
        fs::create_dir_all(&folder).unwrap();
        fs::write(&settings.path, "{\"starts\": {\"moon\": broken").unwrap();
        let (lat, lon, zoom) = (json!(1), json!(2), json!(3));
        settings.set_start("mars", Some(&lat), Some(&lon), Some(&zoom)).unwrap();
        assert_eq!(settings.starts().unwrap(), json!({"mars": {"lat": 1.0, "lon": 2.0, "zoom": 3.0}}));
        let aside: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("settings.json.broken-"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            fs::read_to_string(folder.join(&aside[0])).unwrap(),
            "{\"starts\": {\"moon\": broken",
            "kept as it was"
        );
    }

    #[test]
    fn starts_of_another_shape_are_replaced() {
        let settings = file("shape");
        fs::create_dir_all(settings.path.parent().unwrap()).unwrap();
        fs::write(&settings.path, r#"{"starts": 5}"#).unwrap();
        let (lat, lon, zoom) = (json!(1), json!(2), json!(3));
        settings.set_start("moon", Some(&lat), Some(&lon), Some(&zoom)).unwrap();
        assert_eq!(settings.starts().unwrap(), json!({"moon": {"lat": 1.0, "lon": 2.0, "zoom": 3.0}}));
    }
}

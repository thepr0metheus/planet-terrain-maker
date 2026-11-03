//! The saved models: one folder a model under `data/models`, so that a model saved on a computer opens on a phone too. A
//! folder holds `meta.json` (the name, the places, the settings) and the model's files: the heights of each place
//! (float32), its picture (JPEG) and a small picture for the list. A model removed goes to `data/trash` first, and leaves
//! it after `TRASH_DAYS`.

use crate::atomic::AtomicFile;
use crate::json_file::JsonRead;
use crate::locked::Locked;
use crate::log::Log;
use crate::random::Random;
use crate::store_error::StoreError;
use rules::model_meta::ModelMeta;
use rules::{Clock, JsonForm, Refused, Stamp};
use serde_json::{Map, Value};
use std::fs::{self, File};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Why a model was not given or kept.
#[derive(Debug, PartialEq, Eq)]
pub enum LibraryError {
    /// No model with that id, or no such file in it.
    NotFound,
    /// What was sent cannot be kept: the words say why.
    Refused(String),
    /// The disk.
    Store(StoreError),
}

impl From<StoreError> for LibraryError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<io::Error> for LibraryError {
    fn from(error: io::Error) -> Self {
        Self::Store(error.into())
    }
}

impl From<Refused> for LibraryError {
    fn from(refused: Refused) -> Self {
        Self::Refused(refused.0)
    }
}

/// The models.
pub struct Library {
    root: PathBuf,
    trash: PathBuf,
    clock: Arc<dyn Clock>,
    log: Log,
    writing: Locked<()>,
}

impl Library {
    /// The models under `root`, and what was removed under `trash`.
    pub fn new(root: PathBuf, trash: PathBuf, clock: Arc<dyn Clock>, log: Log) -> Self {
        Self { root, trash, clock, log, writing: Locked::new(()) }
    }

    // ---------- reading ----------

    /// Every model, the last changed first: id, name, created, updated, worlds, places (name and world of each), and the
    /// files it has. A folder that holds no readable model is left out, and the log says which.
    pub fn list(&self) -> Result<Vec<Value>, StoreError> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut models = Vec::new();
        for entry in entries {
            let entry = entry.map_err(StoreError::from)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ModelMeta::is_id(&name)
                && let Some(model) = self.listed(&entry.path().join("meta.json"), &name)?
            {
                models.push(model);
            }
        }
        models.sort_by(|one, other| ModelMeta::updated_of(other).cmp(ModelMeta::updated_of(one)));
        Ok(models)
    }

    fn listed(&self, meta: &Path, name: &str) -> Result<Option<Value>, StoreError> {
        let model = match JsonRead::of(meta)? {
            JsonRead::Absent => None,
            JsonRead::Broken => None,
            JsonRead::Value(meta) => ModelMeta::listed(&meta),
        };
        if model.is_none() {
            self.log.say(&format!("models: {name} holds no readable model, and is not listed"));
        }
        Ok(model)
    }

    /// A model's meta.
    pub fn get(&self, model_id: &str) -> Result<Value, LibraryError> {
        let path = self.folder(model_id)?.join("meta.json");
        match JsonRead::of(&path)? {
            JsonRead::Absent => Err(LibraryError::NotFound),
            JsonRead::Broken => Err(StoreError::failed(format!("{} cannot be read", path.display())).into()),
            JsonRead::Value(meta) => Ok(meta),
        }
    }

    /// Where a file of a model lies.
    pub fn file(&self, model_id: &str, name: &str) -> Result<PathBuf, LibraryError> {
        if !ModelMeta::is_file_name(name) {
            return Err(LibraryError::NotFound);
        }
        let path = self.folder(model_id)?.join(name);
        if path.is_file() { Ok(path) } else { Err(LibraryError::NotFound) }
    }

    // ---------- writing ----------

    /// Saves a new model, and gives its meta. `files`: each file's name and bytes.
    pub fn create(&self, meta: &Value, files: &[(String, &[u8])]) -> Result<Value, LibraryError> {
        let model_id = Random::hex(6)?;
        let stamp = self.now();
        let mut fields = Self::checked(meta, files)?;
        Self::stamped(&mut fields, &model_id, Value::from(stamp.as_str()), &stamp);
        let meta = Value::Object(fields);
        self.save(&model_id, &meta, files, false)?;
        Ok(meta)
    }

    /// Everything of a model anew: meta and files. Kept from before: the id and when it was made. A model removed while
    /// the new one was written stays removed.
    pub fn replace(&self, model_id: &str, meta: &Value, files: &[(String, &[u8])]) -> Result<Value, LibraryError> {
        let before = self.get(model_id)?;
        let mut fields = Self::checked(meta, files)?;
        // absent-ok: a model that never said when it was made keeps saying nothing of it, as it always did.
        let created = before.get("created").cloned().unwrap_or(Value::Null);
        Self::stamped(&mut fields, model_id, created, &self.now());
        let meta = Value::Object(fields);
        self.save(model_id, &meta, files, true)?;
        Ok(meta)
    }

    /// A new model with all of this one, its files and settings: a new id, a name (this one's when none is given), made
    /// now. The copy is written beside the others and then takes its place.
    pub fn copy(&self, model_id: &str, name: Option<&Value>) -> Result<Value, LibraryError> {
        let source = self.folder(model_id)?;
        let meta = self.get(model_id)?;
        let new_id = Random::hex(6)?;
        let stamp = self.now();
        let name =
            ModelMeta::name(name.filter(|name| !name.is_null()).or_else(|| meta.get("name")).unwrap_or(&Value::Null))?;
        let Value::Object(mut fields) = meta else {
            return Err(StoreError::failed("the meta of a model is no table").into());
        };
        fields.insert("name".to_string(), Value::String(name));
        Self::stamped(&mut fields, &new_id, Value::from(stamp.as_str()), &stamp);
        let meta = Value::Object(fields);
        let fresh = self.fresh_folder(&new_id)?;
        let copied = Self::copy_files(&source, &fresh)
            .and_then(|()| Self::write_file(&fresh.join("meta.json"), JsonForm::FILE.write(&meta).as_bytes()))
            .and_then(|()| AtomicFile::sync_folder(&fresh))
            .map_err(Self::gone_is_not_found)
            .and_then(|()| self.writing.with(|()| self.take_place(&fresh, &new_id, false)));
        if copied.is_err() {
            drop(fs::remove_dir_all(&fresh));
        }
        copied?;
        Ok(meta)
    }

    /// A new name for the model, and with `places` for its places too.
    pub fn rename(&self, model_id: &str, name: &Value, places: Option<&Value>) -> Result<Value, LibraryError> {
        self.writing.with(|()| {
            let meta = self.get(model_id)?;
            let renamed = ModelMeta::renamed(&meta, name, places)?;
            let Value::Object(mut fields) = renamed else {
                return Err(StoreError::failed("the meta of a model is no table").into());
            };
            fields.insert("updated".to_string(), Value::String(self.now()));
            let meta = Value::Object(fields);
            Self::write_meta(&self.folder(model_id)?.join("meta.json"), &meta)?;
            Ok(meta)
        })
    }

    /// Moves a model to the trash, and empties the trash of what lay there too long.
    pub fn remove(&self, model_id: &str) -> Result<(), LibraryError> {
        self.writing.with(|()| {
            let folder = self.folder(model_id)?;
            if !folder.is_dir() {
                return Err(LibraryError::NotFound);
            }
            fs::create_dir_all(&self.trash)?;
            fs::rename(&folder, self.trash.join(format!("{model_id}-{}", self.clock.now() as u64)))?;
            Ok::<(), LibraryError>(())
        })?;
        self.empty_trash();
        Ok(())
    }

    /// A folder that does not go leaves the trash next time.
    fn empty_trash(&self) {
        let Ok(entries) = fs::read_dir(&self.trash) else {
            return;
        };
        let now = self.clock.now();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let too_old = ModelMeta::trashed_at(&name.to_string_lossy())
                .is_some_and(|stamp| now - stamp > ModelMeta::TRASH_DAYS * 86400.0);
            if too_old {
                drop(fs::remove_dir_all(entry.path()));
            }
        }
    }

    // ---------- inside ----------

    fn now(&self) -> String {
        Stamp::iso(self.clock.now())
    }

    fn folder(&self, model_id: &str) -> Result<PathBuf, LibraryError> {
        if ModelMeta::is_id(model_id) { Ok(self.root.join(model_id)) } else { Err(LibraryError::NotFound) }
    }

    fn checked(meta: &Value, files: &[(String, &[u8])]) -> Result<Map<String, Value>, Refused> {
        let sizes: Vec<(String, usize)> = files.iter().map(|(name, body)| (name.clone(), body.len())).collect();
        ModelMeta::checked(meta, &sizes)
    }

    fn stamped(fields: &mut Map<String, Value>, model_id: &str, created: Value, updated: &str) {
        fields.insert("id".to_string(), Value::from(model_id));
        fields.insert("created".to_string(), created);
        fields.insert("updated".to_string(), Value::from(updated));
    }

    fn write_meta(path: &Path, meta: &Value) -> io::Result<()> {
        AtomicFile::write(path, JsonForm::FILE.write(meta).as_bytes(), AtomicFile::OPEN)
    }

    fn fresh_folder(&self, model_id: &str) -> Result<PathBuf, StoreError> {
        fs::create_dir_all(&self.root)?;
        let fresh = self.root.join(format!(".new-{model_id}-{}", Random::hex(3)?));
        fs::create_dir(&fresh)?;
        Ok(fresh)
    }

    /// The new folder is written beside the old one, every byte of it on the disk, and then takes its place: a reader
    /// sees the old model or the new one, never half of each. For the moment between the two renames, neither: a request
    /// then hears there is no such model. Only the renames hold the lock.
    fn save(
        &self,
        model_id: &str,
        meta: &Value,
        files: &[(String, &[u8])],
        replacing: bool,
    ) -> Result<(), LibraryError> {
        let fresh = self.fresh_folder(model_id)?;
        let saved = Self::fill(&fresh, meta, files)
            .map_err(LibraryError::from)
            .and_then(|()| self.writing.with(|()| self.take_place(&fresh, model_id, replacing)));
        if saved.is_err() {
            drop(fs::remove_dir_all(&fresh));
        }
        saved
    }

    fn fill(fresh: &Path, meta: &Value, files: &[(String, &[u8])]) -> io::Result<()> {
        for (name, body) in files {
            Self::write_file(&fresh.join(name), body)?;
        }
        Self::write_file(&fresh.join("meta.json"), JsonForm::FILE.write(meta).as_bytes())?;
        AtomicFile::sync_folder(fresh)
    }

    fn write_file(path: &Path, body: &[u8]) -> io::Result<()> {
        let mut file = File::create_new(path)?;
        file.write_all(body)?;
        file.sync_all()
    }

    /// The new folder takes the model's place. When the second rename fails, the old folder is put back.
    fn take_place(&self, fresh: &Path, model_id: &str, replacing: bool) -> Result<(), LibraryError> {
        let target = self.root.join(model_id);
        if target.exists() {
            let old = self.root.join(format!(".old-{model_id}-{}", Random::hex(3)?));
            fs::rename(&target, &old)?;
            if let Err(error) = fs::rename(fresh, &target) {
                // What cannot be put back stays as `.old-`, and `recover` puts it back at the next start.
                drop(fs::rename(&old, &target));
                return Err(error.into());
            }
            drop(fs::remove_dir_all(&old));
        } else if replacing {
            return Err(LibraryError::NotFound);
        } else {
            fs::rename(fresh, &target)?;
        }
        AtomicFile::sync_folder(&self.root)?;
        Ok(())
    }

    fn copy_files(source: &Path, fresh: &Path) -> io::Result<()> {
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            // The meta is written anew, the copy's own.
            if entry.file_name() == "meta.json" {
                continue;
            }
            let target = fresh.join(entry.file_name());
            fs::copy(entry.path(), &target)?;
            File::open(&target)?.sync_all()?;
        }
        Ok(())
    }

    /// A model that went to the trash while it was copied is no model to copy.
    fn gone_is_not_found(error: io::Error) -> LibraryError {
        if error.kind() == io::ErrorKind::NotFound { LibraryError::NotFound } else { error.into() }
    }

    /// What a save cut short left in the folder of models, said; a model only its old copy holds is put back.
    pub fn recover(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut said = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(model_id) = name.strip_prefix(".old-").and_then(|rest| rest.get(..12)) {
                let target = self.root.join(model_id);
                if !target.exists() && fs::rename(entry.path(), &target).is_ok() {
                    said.push(format!("models: {model_id} put back from {name}, which a save cut short left"));
                } else {
                    said.push(format!(
                        "models: {name} is left from a save cut short, beside {model_id}: see to it by hand"
                    ));
                }
            } else if name.starts_with(".new-") {
                said.push(format!("models: {name} is half of a save cut short: see to it by hand"));
            }
        }
        said
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::StillClock;
    use serde_json::json;

    fn library(name: &str) -> (Library, PathBuf, Arc<StillClock>) {
        let root = std::env::temp_dir().join(format!("ptm-library-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        let clock = Arc::new(StillClock::at(2_000_000_000.0));
        let shared: Arc<dyn Clock> = clock.clone();
        (Library::new(root.join("models"), root.join("trash"), shared.clone(), Log::new(shared)), root, clock)
    }

    #[test]
    fn saved_listed_and_read() {
        let (models, root, _) = library("saved");
        let meta =
            models.create(&json!({"name": " a  b ", "worlds": ["earth"]}), &[("x.bin".to_string(), b"1234")]).unwrap();
        let id = meta["id"].as_str().unwrap();
        assert!(ModelMeta::is_id(id));
        assert_eq!(meta["name"], "a b");
        assert_eq!(meta["files"], json!({"x.bin": 4}));
        assert_eq!(meta["created"], "2033-05-18T03:33:20+00:00");
        assert_eq!(models.list().unwrap()[0]["id"], id);
        assert_eq!(models.get(id).unwrap(), meta);
        assert_eq!(fs::read(models.file(id, "x.bin").unwrap()).unwrap(), b"1234");
        assert_eq!(models.file(id, "y.bin"), Err(LibraryError::NotFound));
        assert_eq!(models.file(id, "meta.json"), Err(LibraryError::NotFound));
        assert_eq!(models.get("nothing"), Err(LibraryError::NotFound));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_again_it_keeps_its_id_and_its_day_and_leaves_nothing_behind() {
        let (models, root, clock) = library("again");
        let first = models.create(&json!({"name": "a"}), &[("x.bin".to_string(), b"1")]).unwrap();
        let id = first["id"].as_str().unwrap();
        clock.pass(100.0);
        let again = models.replace(id, &json!({"name": "b"}), &[("y.bin".to_string(), b"22")]).unwrap();
        assert_eq!((&again["id"], &again["created"], &again["name"]), (&first["id"], &first["created"], &json!("b")));
        assert_ne!(again["updated"], first["updated"]);
        assert_eq!(models.file(id, "x.bin"), Err(LibraryError::NotFound));
        let left: Vec<_> = fs::read_dir(root.join("models")).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(left, [std::ffi::OsString::from(id)]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_copy_has_its_own_id_and_all_the_files() {
        let (models, root, _) = library("copy");
        let first = models.create(&json!({"name": "a", "settings": {"s": 1}}), &[("x.bin".to_string(), b"1")]).unwrap();
        let id = first["id"].as_str().unwrap();
        let copy = models.copy(id, Some(&json!("c"))).unwrap();
        assert_ne!(copy["id"], first["id"]);
        assert_eq!((&copy["name"], &copy["settings"]), (&json!("c"), &json!({"s": 1})));
        let same = models.copy(id, None).unwrap();
        assert_eq!(same["name"], "a");
        assert!(matches!(models.copy(id, Some(&json!("  "))), Err(LibraryError::Refused(_))));
        assert_eq!(fs::read(models.file(copy["id"].as_str().unwrap(), "x.bin").unwrap()).unwrap(), b"1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removed_to_the_trash_and_out_of_it_after_its_days() {
        let (models, root, clock) = library("trash");
        let one = models.create(&json!({"name": "a"}), &[]).unwrap();
        let two = models.create(&json!({"name": "b"}), &[]).unwrap();
        models.remove(one["id"].as_str().unwrap()).unwrap();
        assert_eq!(models.remove(one["id"].as_str().unwrap()), Err(LibraryError::NotFound));
        assert_eq!(models.list().unwrap().len(), 1);
        assert_eq!(fs::read_dir(root.join("trash")).unwrap().count(), 1);
        clock.pass(31.0 * 86400.0);
        models.remove(two["id"].as_str().unwrap()).unwrap();
        let left: Vec<String> = fs::read_dir(root.join("trash"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), 1);
        assert!(left[0].starts_with(two["id"].as_str().unwrap()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_folder_that_cannot_be_written_is_said_as_such() {
        use std::os::unix::fs::PermissionsExt;
        let (models, root, _) = library("denied");
        fs::create_dir_all(root.join("models")).unwrap();
        fs::set_permissions(root.join("models"), fs::Permissions::from_mode(0o500)).unwrap();
        if fs::write(root.join("models").join("probe"), b"").is_ok() {
            // Root writes where the test forbids it: there is nothing to see here.
            fs::remove_dir_all(root).unwrap();
            return;
        }
        let refused = models.create(&json!({"name": "a"}), &[]);
        fs::set_permissions(root.join("models"), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(refused, Err(LibraryError::Store(StoreError::Denied(_)))), "{refused:?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_save_cut_short_is_put_back_or_said() {
        let (models, root, _) = library("recover");
        let kept = models.create(&json!({"name": "a"}), &[]).unwrap();
        let id = kept["id"].as_str().unwrap();
        let folder = root.join("models");
        fs::rename(folder.join(id), folder.join(format!(".old-{id}-abcdef"))).unwrap();
        fs::create_dir_all(folder.join(".new-ffffffffffff-012345")).unwrap();
        let said = models.recover();
        assert!(said.iter().any(|line| line.contains("put back")), "{said:?}");
        assert!(said.iter().any(|line| line.contains("half of a save")), "{said:?}");
        assert_eq!(models.get(id).unwrap(), kept);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_model_removed_while_it_was_saved_again_stays_removed() {
        let (models, root, _) = library("removed");
        let kept = models.create(&json!({"name": "a"}), &[]).unwrap();
        let id = kept["id"].as_str().unwrap();
        let fresh = models.fresh_folder(id).unwrap();
        models.remove(id).unwrap();
        assert_eq!(models.take_place(&fresh, id, true), Err(LibraryError::NotFound));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_last_changed_comes_first_and_what_is_no_model_is_left_out() {
        let (models, root, clock) = library("order");
        let older = models.create(&json!({"name": "older"}), &[]).unwrap();
        clock.pass(10.0);
        let newer = models.create(&json!({"name": "newer"}), &[]).unwrap();
        for folder in ["not-a-model", "0123456789ab", "ffffffffffff"] {
            fs::create_dir_all(root.join("models").join(folder)).unwrap();
        }
        fs::write(root.join("models/ffffffffffff/meta.json"), "{broken").unwrap();
        let ids: Vec<&Value> =
            models.list().unwrap().iter().map(|model| model["id"].clone()).collect::<Vec<_>>().leak().iter().collect();
        assert_eq!(ids, [&newer["id"], &older["id"]]);
        fs::remove_dir_all(root).unwrap();
    }
}

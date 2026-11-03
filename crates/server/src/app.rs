//! What a request may need: the stores, the services, and what the process knows.

use crate::clock::SystemClock;
use crate::packages::InstalledPackages;
use crate::settings::Settings;
use files::{
    ClientErrors, DetailTiles, KeptFiles, KeyStore, Library, Log, PictureCopies, PictureSources, SettingsFile,
    TileStore,
};
use rules::Clock;
use services::{CopernicusAws, Fetch, HttpFetcher, Nominatim, OpenTopography, Overpass, ShapeFiles, TileRelay, Trek};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

/// What lies in the data folder.
pub struct Stores {
    /// The saved models.
    pub library: Library,
    /// What is set for every device.
    pub settings: SettingsFile,
    /// The OpenTopography key.
    pub keys: Arc<KeyStore>,
    /// The picture sources people entered.
    pub picture_sources: PictureSources,
    /// The tiles browsers uploaded.
    pub detail_tiles: DetailTiles,
    /// The page's own reports.
    pub client_errors: ClientErrors,
    /// Smaller copies of pictures.
    pub picture_copies: PictureCopies,
}

/// The services the app takes its data from.
pub struct Outside {
    /// Map tiles.
    pub tiles: TileRelay,
    /// Copernicus on AWS.
    pub copernicus_aws: CopernicusAws,
    /// Copernicus through OpenTopography.
    pub open_topography: OpenTopography,
    /// The Moon, Mars and Venus.
    pub trek: Trek,
    /// Names of places.
    pub nominatim: Nominatim,
    /// Buildings.
    pub overpass: Overpass,
    /// Shapes of asteroids, comets and spacecraft.
    pub shapes: ShapeFiles,
}

/// The app.
pub struct App {
    /// What lies in the data folder.
    pub stores: Stores,
    /// The services.
    pub outside: Outside,
    /// What this copy is made of.
    pub packages: InstalledPackages,
    /// The commit this copy was made from; `None` for a working copy.
    pub version: Option<String>,
    /// The page.
    pub web: PathBuf,
    /// The log.
    pub log: Log,
    /// The time.
    pub clock: Arc<dyn Clock>,
}

impl App {
    /// Wires the parts. Refused when the page's own lists cannot be read.
    pub fn new(settings: &Settings) -> Result<Self, String> {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock::new());
        let log = Log::new(Arc::clone(&clock));
        let fetcher = Self::fetcher(settings);
        let keys = Arc::new(KeyStore::new(settings.data.join("keys").join("opentopo"), settings.opentopo_key.clone()));
        let stores = Self::stores(settings, &clock, &log, &keys);
        let outside = Self::outside(settings, &fetcher, &clock, &log, &keys)?;
        Ok(Self {
            stores,
            outside,
            packages: InstalledPackages::new(
                PathBuf::from("/etc/os-release"),
                PathBuf::from("/lib/apk/db/installed"),
                settings.web.join("vendor").join("VERSIONS.json"),
            ),
            version: Self::version_in(settings, &log),
            web: settings.web.clone(),
            log,
            clock,
        })
    }

    #[cfg(feature = "test-upstream")]
    fn fetcher(settings: &Settings) -> Arc<dyn Fetch> {
        match &settings.test_upstream {
            Some(address) => Arc::new(HttpFetcher::local(&settings.user_agent, address.clone())),
            None => Arc::new(HttpFetcher::new(&settings.user_agent)),
        }
    }

    #[cfg(not(feature = "test-upstream"))]
    fn fetcher(settings: &Settings) -> Arc<dyn Fetch> {
        Arc::new(HttpFetcher::new(&settings.user_agent))
    }

    fn stores(settings: &Settings, clock: &Arc<dyn Clock>, log: &Log, keys: &Arc<KeyStore>) -> Stores {
        let data = &settings.data;
        let kept = KeptFiles::new(data.join("cache").join("pictures"), "pictures: smaller copies are", log.clone());
        Stores {
            library: Library::new(data.join("models"), data.join("trash"), Arc::clone(clock), log.clone()),
            settings: SettingsFile::new(data.join("settings.json"), log.clone()),
            keys: Arc::clone(keys),
            picture_sources: PictureSources::new(data.join("picture-sources.json")),
            detail_tiles: DetailTiles::new(data.join("picture-tiles")),
            client_errors: ClientErrors::new(data.join("client-errors.jsonl"), Arc::clone(clock), log.clone()),
            picture_copies: PictureCopies::new(kept),
        }
    }

    fn outside(
        settings: &Settings,
        fetcher: &Arc<dyn Fetch>,
        clock: &Arc<dyn Clock>,
        log: &Log,
        keys: &Arc<KeyStore>,
    ) -> Result<Outside, String> {
        let cache = settings.data.join("cache");
        let kept = |folder: &str, subject: &'static str| KeptFiles::new(cache.join(folder), subject, log.clone());
        let tiles = TileStore::new(kept("tiles", "tile store: tiles are"), settings.tile_cache_bytes);
        let shapes = kept("asteroids", "shapes: shapes are");
        Ok(Outside {
            tiles: TileRelay::new(tiles, Arc::clone(fetcher), Arc::clone(clock), log.clone()),
            copernicus_aws: CopernicusAws::new(Arc::clone(fetcher), kept("copernicus", "copernicus: pieces are")),
            open_topography: OpenTopography::new(Arc::clone(fetcher), Arc::clone(keys)),
            trek: Trek::new(Arc::clone(fetcher), log.clone()),
            nominatim: Nominatim::new(Arc::clone(fetcher), Arc::clone(clock)),
            overpass: Overpass::new(
                Arc::clone(fetcher),
                kept("buildings", "buildings: the answer is"),
                Arc::clone(clock),
                log.clone(),
            ),
            shapes: ShapeFiles::new(Arc::clone(fetcher), shapes, &settings.web.join("data"))?,
        })
    }

    /// The commit: `git archive` writes it into `VERSION`, and a working copy leaves its placeholder there, or none. A
    /// file that is there and cannot be read is said: `/healthz` then names no commit, which the check after a
    /// deployment does not let pass.
    fn version_in(settings: &Settings, log: &Log) -> Option<String> {
        let text = match fs::read_to_string(&settings.version_file) {
            Ok(text) => text,
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    log.say(&format!("{} cannot be read: {error}", settings.version_file.display()));
                }
                return None;
            }
        };
        let text = text.trim();
        (!text.is_empty() && !text.starts_with("$Format")).then(|| text.to_string())
    }
}

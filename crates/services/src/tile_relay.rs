//! Map tiles through our own server: the page asks `/api/tile/<source>/<z>/<x>/<y>`, the server fetches the tile once from
//! its service and keeps it on disk. Why not straight from the services: the page draws tiles into canvases (a capture
//! stitches them, the planets' maps stretch their greys), and a canvas may read pixels only from its own site.

use crate::fetcher::{Answer, Fetch, FetchError};
use files::{Locked, Log, StoreError, TileAddress, TileStore};
use rules::Clock;
use rules::tile_source::TileSource;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;

/// A tile as the page gets it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tile {
    /// Its bytes.
    pub body: Vec<u8>,
    /// Its type of content, without parameters.
    pub content_type: String,
}

/// Why there is no tile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileError {
    /// The service has no such tile (it answered 404, or did so lately).
    Missing,
    /// The service failed otherwise.
    Failed(FetchError),
    /// The disk.
    Store(StoreError),
}

impl From<StoreError> for TileError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

/// So many fetches at a time from one service, at most. The hold lets go by itself on any way out.
struct Gate {
    free: Mutex<usize>,
    released: Condvar,
}

struct GateHold<'a> {
    gate: &'a Gate,
}

impl Gate {
    fn new(at_once: usize) -> Self {
        Self { free: Mutex::new(at_once), released: Condvar::new() }
    }

    fn hold(&self) -> GateHold<'_> {
        let mut free = self.free.lock().unwrap_or_else(PoisonError::into_inner);
        while *free == 0 {
            free = self.released.wait(free).unwrap_or_else(PoisonError::into_inner);
        }
        *free -= 1;
        GateHold { gate: self }
    }
}

impl Drop for GateHold<'_> {
    fn drop(&mut self) {
        *self.gate.free.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        self.gate.released.notify_one();
    }
}

/// When the store was last looked at, and whether someone is at it now.
#[derive(Debug, Default)]
struct Trimming {
    last: f64,
    running: bool,
}

/// Lets go of `running` on any way out of a trim.
struct TrimDone(Arc<Locked<Trimming>>);

impl Drop for TrimDone {
    fn drop(&mut self) {
        self.0.with(|trimming| trimming.running = false);
    }
}

/// Fetches tiles and keeps them.
pub struct TileRelay {
    sources: Vec<TileSource>,
    store: Arc<TileStore>,
    fetcher: Arc<dyn Fetch>,
    clock: Arc<dyn Clock>,
    log: Log,
    gates: Locked<HashMap<&'static str, Arc<Gate>>>,
    trimming: Arc<Locked<Trimming>>,
}

impl TileRelay {
    /// Seconds between two looks at the size of the store, at most.
    const TRIM_EVERY: f64 = 600.0;
    /// A busy service (EOX, Esri) now and then answers 5xx, 429 or nothing, and the next request gets the tile: a failed
    /// fetch is asked again after these pauses before it counts.
    const REPEAT_AFTER: [f64; 2] = [0.5, 1.5];
    const SECONDS: u64 = 30;

    /// A relay for every layer there is.
    pub fn new(store: TileStore, fetcher: Arc<dyn Fetch>, clock: Arc<dyn Clock>, log: Log) -> Self {
        Self {
            sources: TileSource::all(),
            store: Arc::new(store),
            fetcher,
            clock,
            log,
            gates: Locked::new(HashMap::new()),
            trimming: Arc::new(Locked::new(Trimming::default())),
        }
    }

    /// The layer of this name.
    pub fn source(&self, id: &str) -> Option<&TileSource> {
        self.sources.iter().find(|source| source.id == id)
    }

    /// The tile, from the disk or from its service.
    pub fn get(&self, source: &TileSource, z: u64, x: u64, y: u64) -> Result<Tile, TileError> {
        let address = TileAddress { layer: source.id, extension: source.kind.extension(), z, x, y };
        if let Some(body) = self.store.read(&address, self.clock.now())? {
            return Ok(Tile { body, content_type: source.kind.content_type().to_string() });
        }
        if self.store.is_missing(&address, self.clock.now())? {
            return Err(TileError::Missing);
        }
        let answer = match self.fetch(source, &source.url_of(z, x, y)) {
            Ok(answer) => answer,
            Err(error) if error.status == Some(404) => {
                self.store.remember_missing(&address);
                return Err(TileError::Missing);
            }
            Err(error) => return Err(TileError::Failed(error)),
        };
        if !answer.content_type.starts_with("image/") {
            let said = if answer.content_type.is_empty() { "no type" } else { &answer.content_type };
            let words = format!("{} {z}/{x}/{y}: not a picture ({said})", source.id);
            return Err(TileError::Failed(FetchError::new(words)));
        }
        if self.store.keep(&address, &answer.body) {
            self.maybe_trim();
        }
        // absent-ok: a split gives a first piece.
        let content_type = answer.content_type.split(';').next().unwrap_or_default().to_string();
        Ok(Tile { body: answer.body, content_type })
    }

    fn fetch(&self, source: &TileSource, url: &str) -> Result<Answer, FetchError> {
        let gate = self
            .gates
            .with(|gates| Arc::clone(gates.entry(source.id).or_insert_with(|| Arc::new(Gate::new(source.at_once)))));
        let mut pauses = Self::REPEAT_AFTER.iter();
        loop {
            let answered = {
                let _hold = gate.hold();
                self.fetcher.get(url, &[], Self::SECONDS)
            };
            match (answered, pauses.next()) {
                (Err(error), Some(pause)) if error.is_passing() => self.clock.sleep(*pause),
                (answered, _) => return answered,
            }
        }
    }

    /// Looks at the size of the store on a thread of its own: a walk over the tiles takes its time, and no tile waits.
    fn maybe_trim(&self) {
        let now = self.clock.now();
        let due = self.trimming.with(|trimming| {
            let due = now - trimming.last >= Self::TRIM_EVERY && !trimming.running;
            if due {
                trimming.last = now;
                trimming.running = true;
            }
            due
        });
        if !due {
            return;
        }
        let (store, log, done) = (Arc::clone(&self.store), self.log.clone(), TrimDone(Arc::clone(&self.trimming)));
        let started = thread::Builder::new().name("tile-trim".to_string()).spawn(move || {
            let _done = done;
            if let Err(error) = store.trim() {
                log.say(&format!("tile store: trim failed: {error}"));
            }
        });
        if let Err(error) = started {
            self.log.say(&format!("tile store: no thread for the trim: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetcher::fakes::{FakeFetch, answer};
    use files::KeptFiles;
    use rules::StillClock;

    fn relay(
        name: &str,
        table: Vec<(&'static str, Result<Answer, FetchError>)>,
    ) -> (TileRelay, Arc<FakeFetch>, Arc<StillClock>) {
        let root = std::env::temp_dir().join(format!("ptm-relay-{name}-{}", std::process::id()));
        drop(std::fs::remove_dir_all(&root));
        let fake = Arc::new(FakeFetch::new(table));
        let clock = Arc::new(StillClock::at(1_000_000.0));
        let shared: Arc<dyn Clock> = clock.clone();
        let log = Log::new(shared.clone());
        let store = TileStore::new(KeptFiles::new(root, "tile store: tiles are", log.clone()), 1 << 30);
        let fetcher: Arc<dyn Fetch> = fake.clone();
        (TileRelay::new(store, fetcher, shared, log), fake, clock)
    }

    #[test]
    fn a_failure_that_may_pass_is_asked_again_after_its_pauses_and_a_refusal_is_not() {
        for (status, times, waited) in [(500, 3, 2.0), (429, 3, 2.0), (403, 1, 0.0)] {
            let (tiles, fake, clock) =
                relay(&format!("again-{status}"), vec![("World", Err(FetchError::of_status(status)))]);
            let before = clock.now();
            let source = tiles.source("earth-photo").unwrap().clone();
            assert!(matches!(tiles.get(&source, 3, 1, 2), Err(TileError::Failed(_))));
            assert_eq!(fake.asked.with(|asked| asked.len()), times, "{status}");
            assert_eq!(clock.now() - before, waited, "{status}");
        }
    }

    #[test]
    fn a_tile_the_service_does_not_have_is_not_asked_for_again_soon() {
        let (tiles, fake, _) = relay("missing", vec![("World", Err(FetchError::of_status(404)))]);
        let source = tiles.source("earth-photo").unwrap().clone();
        for _ in 0..3 {
            assert_eq!(tiles.get(&source, 3, 1, 2), Err(TileError::Missing));
        }
        assert_eq!(fake.asked.with(|asked| asked.len()), 1);
    }

    #[test]
    fn a_tile_is_fetched_once_and_its_type_comes_without_parameters() {
        let (tiles, fake, _) = relay("once", vec![("World", answer(b"j", "image/jpeg; x=y"))]);
        let source = tiles.source("earth-photo").unwrap().clone();
        assert_eq!(tiles.get(&source, 3, 1, 2).unwrap().content_type, "image/jpeg");
        assert_eq!(tiles.get(&source, 3, 1, 2).unwrap().content_type, "image/jpeg");
        assert_eq!(fake.asked.with(|asked| asked.len()), 1);
    }

    #[test]
    fn an_error_page_is_no_tile() {
        let (tiles, _, _) = relay("page", vec![("World", answer(b"<html>", "text/html")), ("USGS", answer(b"x", ""))]);
        let source = tiles.source("earth-photo").unwrap().clone();
        let Err(TileError::Failed(error)) = tiles.get(&source, 3, 1, 2) else {
            panic!("no failure");
        };
        assert_eq!(error.to_string(), "earth-photo 3/1/2: not a picture (text/html)");
        let usgs = tiles.source("earth-usgs").unwrap().clone();
        let Err(TileError::Failed(error)) = tiles.get(&usgs, 3, 1, 2) else {
            panic!("no failure");
        };
        assert!(error.to_string().ends_with("(no type)"));
    }

    #[test]
    fn a_gate_lets_so_many_through() {
        let gate = Gate::new(2);
        let (one, two) = (gate.hold(), gate.hold());
        assert_eq!(*gate.free.lock().unwrap(), 0);
        drop(one);
        assert_eq!(*gate.free.lock().unwrap(), 1);
        drop(two);
        assert_eq!(*gate.free.lock().unwrap(), 2);
    }
}

//! Names of places on Earth from Nominatim (OpenStreetMap). Nominatim asks for at most one request a second from an
//! application, and for answers to be kept: the server waits its turn and remembers the last answers.

use crate::fetcher::Fetch;
use files::Locked;
use rules::Clock;
use rules::places::PlaceQuestion;
use serde_json::{Value, json};
use std::sync::Arc;

/// Nominatim did not give an answer: the words say why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceError(pub String);

/// The service.
pub struct Nominatim {
    fetcher: Arc<dyn Fetch>,
    clock: Arc<dyn Clock>,
    next_turn: Locked<f64>,
    kept: Locked<Vec<(String, Value)>>,
}

impl Nominatim {
    const GAP: f64 = 1.0; // seconds between two requests
    const KEEP: usize = 256; // answers remembered
    const SECONDS: u64 = 20;

    /// The service, asked through this.
    pub fn new(fetcher: Arc<dyn Fetch>, clock: Arc<dyn Clock>) -> Self {
        Self { fetcher, clock, next_turn: Locked::new(0.0), kept: Locked::new(Vec::new()) }
    }

    /// Up to 8 places whose names match.
    pub fn search(&self, query: &str, language: &str) -> Result<Value, PlaceError> {
        match PlaceQuestion::search(query, language) {
            Some(question) => self.ask(&question),
            None => Ok(json!([])),
        }
    }

    /// The place at a point, or null at sea.
    pub fn reverse(&self, lat: f64, lon: f64, language: &str) -> Result<Value, PlaceError> {
        self.ask(&PlaceQuestion::reverse(lat, lon, language))
    }

    fn ask(&self, question: &PlaceQuestion) -> Result<Value, PlaceError> {
        if let Some(known) = self.remembered(&question.key) {
            return Ok(known);
        }
        self.wait_turn();
        let answer = self
            .fetcher
            .get(&question.url, &[("Accept-Language", question.language)], Self::SECONDS)
            .map_err(|error| PlaceError(format!("Nominatim: {error}")))?;
        let found: Value = serde_json::from_slice(&answer.body)
            .map_err(|error| PlaceError(format!("Nominatim: the answer is no JSON: {error}")))?;
        let result = question.read(&found);
        self.remember(&question.key, &result);
        Ok(result)
    }

    /// The answer kept under this key, which then is the last to go.
    fn remembered(&self, key: &str) -> Option<Value> {
        self.kept.with(|kept| {
            let at = kept.iter().position(|(known, _)| known == key)?;
            let entry = kept.remove(at);
            let value = entry.1.clone();
            kept.push(entry);
            Some(value)
        })
    }

    fn remember(&self, key: &str, value: &Value) {
        self.kept.with(|kept| {
            kept.push((key.to_string(), value.clone()));
            if kept.len() > Self::KEEP {
                kept.remove(0);
            }
        });
    }

    /// Who waits, waits holding the turn: the next one waits after it.
    fn wait_turn(&self) {
        self.next_turn.with(|next| {
            let wait = *next - self.clock.ticks();
            if wait > 0.0 {
                self.clock.sleep(wait);
            }
            *next = self.clock.ticks() + Self::GAP;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetcher::fakes::{FakeFetch, answer};
    use rules::StillClock;

    fn places(table: &[(&'static str, &'static [u8])]) -> (Nominatim, Arc<FakeFetch>, Arc<StillClock>) {
        let fake = Arc::new(FakeFetch::new(
            table.iter().map(|(part, body)| (*part, answer(body, "application/json"))).collect(),
        ));
        let clock = Arc::new(StillClock::at(1000.0));
        let fetcher: Arc<dyn Fetch> = fake.clone();
        let shared: Arc<dyn Clock> = clock.clone();
        (Nominatim::new(fetcher, shared), fake, clock)
    }

    #[test]
    fn one_request_a_second() {
        let (service, _, clock) = places(&[("/search", b"[]")]);
        let start = clock.now();
        for query in ["a", "b", "c"] {
            service.search(query, "en").unwrap();
        }
        assert_eq!(clock.now() - start, 2.0);
    }

    #[test]
    fn answers_are_kept_and_the_oldest_goes() {
        let (service, fake, _) = places(&[("/search", b"[]")]);
        for at in 0..257 {
            service.search(&format!("q{at}"), "en").unwrap();
        }
        let asked = || fake.asked.with(|asked| asked.len());
        assert_eq!(asked(), 257);
        service.search("q256", "en").unwrap();
        assert_eq!(asked(), 257, "kept");
        service.search("q0", "en").unwrap();
        assert_eq!(asked(), 258, "the oldest went");
    }

    #[test]
    fn nothing_to_look_for_is_not_asked() {
        let (service, fake, _) = places(&[]);
        assert_eq!(service.search("   ", "en").unwrap(), json!([]));
        assert_eq!(fake.asked.with(|asked| asked.len()), 0);
    }

    #[test]
    fn what_is_no_json_is_a_failure() {
        let (service, _, _) = places(&[("/search", b"<html>")]);
        assert!(service.search("a", "en").unwrap_err().0.starts_with("Nominatim: "));
    }
}

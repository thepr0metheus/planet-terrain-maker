//! Errors the page reports: written to the log, at most `PER_MINUTE` a minute, and the last `KEEP` of them kept, so that
//! what went wrong on another device (an iPad) can be read without the container's log.

use crate::atomic::AtomicFile;
use crate::locked::Locked;
use crate::log::Log;
use crate::store_error::StoreError;
use rules::{Clock, JsonForm, Letters, PyText, Stamp};
use serde_json::{Map, Value, json};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

/// The reports.
pub struct ClientErrors {
    path: PathBuf,
    clock: Arc<dyn Clock>,
    log: Log,
    times: Locked<Vec<f64>>,
    writing: Locked<()>,
}

impl ClientErrors {
    const PER_MINUTE: usize = 30;
    const FIELD: usize = 600;
    /// The most reports kept.
    pub const KEEP: usize = 300;

    /// The reports kept in this file.
    pub fn new(path: PathBuf, clock: Arc<dyn Clock>, log: Log) -> Self {
        Self { path, clock, log, times: Locked::new(Vec::new()), writing: Locked::new(()) }
    }

    /// Takes a report; `false` when too many came in the last minute.
    pub fn take(&self, report: &Map<String, Value>) -> bool {
        let now = self.clock.now();
        let room = self.times.with(|times| {
            times.retain(|time| now - time < 60.0);
            let room = times.len() < Self::PER_MINUTE;
            if room {
                times.push(now);
            }
            room
        });
        if room {
            self.write_down(report, now);
        }
        room
    }

    fn write_down(&self, report: &Map<String, Value>, now: f64) {
        let field = |name: &str, most: usize| {
            // absent-ok: a field the page did not send is written empty, as it always was.
            let text = report.get(name).map(PyText::of).unwrap_or_default();
            Letters::head(&text, most).to_string()
        };
        let (message, place, page, version) = (
            field("message", Self::FIELD),
            field("where", Self::FIELD),
            field("page", Self::FIELD),
            field("version", Self::FIELD),
        );
        let stack = field("stack", Self::FIELD * 4);
        let details = match report.get("details") {
            Some(details @ Value::Object(_)) => {
                Letters::head(&JsonForm::TEXT.write(details), Self::FIELD * 4).to_string()
            }
            _ => String::new(),
        };
        let automated = report.get("automated") == Some(&Value::Bool(true)); // a browser a test program drives
        let tag = if automated { " (automated)" } else { "" };
        self.log.say(&format!("client error{tag}: {message} [{place}] page {page} version {version}"));
        if !details.is_empty() {
            self.log.say(&format!("  details: {details}"));
        }
        if !stack.is_empty() {
            self.log.say(&format!("  {}", stack.replace('\n', "\n  ")));
        }
        let entry = json!({
            "time": Stamp::plain(now), "message": message, "where": place, "page": page, "version": version,
            "details": details, "agent": field("agent", Self::FIELD), "automated": automated, "stack": stack,
        });
        if let Err(error) = self.keep(&entry) {
            self.log.say(&format!("client errors are not kept: {error}"));
        }
    }

    /// One report a line. Only `\n` ends a line: a letter that ends a line elsewhere (U+2028) stands inside a report.
    fn lines(&self) -> Result<Vec<String>, StoreError> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                Ok(text.split('\n').filter(|line| !line.is_empty()).map(str::to_string).collect())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn keep(&self, entry: &Value) -> Result<(), StoreError> {
        self.writing.with(|()| {
            let mut lines = self.lines()?;
            lines.push(JsonForm::TEXT.write(entry));
            let first = lines.len().saturating_sub(Self::KEEP);
            let kept = lines.get(first..).unwrap_or_default();
            let text = format!("{}\n", kept.join("\n"));
            AtomicFile::write(&self.path, text.as_bytes(), AtomicFile::OPEN)?;
            Ok(())
        })
    }

    /// The last `count` reports kept, the newest last. A line that does not read is left out.
    pub fn recent(&self, count: usize) -> Result<Vec<Value>, StoreError> {
        let lines = self.lines()?;
        let first = lines.len().saturating_sub(count);
        let last = lines.get(first..).unwrap_or_default();
        Ok(last.iter().filter_map(|line| serde_json::from_str(line).ok()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::StillClock;

    fn reports(name: &str) -> (ClientErrors, Arc<StillClock>) {
        let root = std::env::temp_dir().join(format!("ptm-reports-{name}-{}", std::process::id()));
        drop(fs::remove_dir_all(&root));
        let clock = Arc::new(StillClock::at(1_000_000.0));
        let shared: Arc<dyn Clock> = clock.clone();
        (ClientErrors::new(root.join("client-errors.jsonl"), shared.clone(), Log::new(shared)), clock)
    }

    fn report(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn at_most_so_many_a_minute() {
        let (errors, clock) = reports("minute");
        let one = report(json!({"message": "boom"}));
        for _ in 0..30 {
            assert!(errors.take(&one));
        }
        assert!(!errors.take(&one));
        clock.pass(61.0);
        assert!(errors.take(&one));
    }

    #[test]
    fn a_report_is_kept_in_its_order_and_its_fields_are_cut() {
        let (errors, _) = reports("kept");
        errors.take(&report(json!({"message": "m".repeat(700), "stack": "s".repeat(3000), "details": {"a": "d".repeat(3000)}, "automated": "yes", "where": null})));
        let kept = errors.recent(5).unwrap();
        let entry = kept[0].as_object().unwrap();
        assert_eq!(
            entry.keys().collect::<Vec<_>>(),
            ["time", "message", "where", "page", "version", "details", "agent", "automated", "stack"]
        );
        assert_eq!(entry["message"].as_str().unwrap().len(), 600);
        assert_eq!(entry["stack"].as_str().unwrap().len(), 2400);
        assert_eq!(entry["details"].as_str().unwrap().len(), 2400);
        assert_eq!(entry["automated"], false);
        assert_eq!(entry["where"], "None");
        assert_eq!(entry["time"], "1970-01-12 13:46:40");
    }

    #[test]
    fn at_most_so_many_are_kept_and_a_broken_line_does_not_stop_the_reading() {
        let (errors, clock) = reports("many");
        for at in 0..310 {
            clock.pass(61.0);
            errors.take(&report(json!({"message": at.to_string()})));
        }
        let kept = errors.recent(1000).unwrap();
        assert_eq!(kept.len(), 300);
        assert_eq!(kept[0]["message"], "10");
        assert_eq!(kept[299]["message"], "309");
        let mut text = fs::read_to_string(&errors.path).unwrap();
        text.push_str("{broken\n");
        fs::write(&errors.path, text).unwrap();
        assert_eq!(errors.recent(1).unwrap().len(), 0);
        assert_eq!(errors.recent(2).unwrap()[0]["message"], "309");
    }

    #[test]
    fn a_letter_that_ends_a_line_elsewhere_stays_in_its_report() {
        let (errors, _) = reports("separator");
        errors.take(&report(json!({"message": "a\u{2028}b"})));
        errors.take(&report(json!({"message": "c"})));
        assert_eq!(errors.recent(5).unwrap()[0]["message"], "a\u{2028}b");
    }
}

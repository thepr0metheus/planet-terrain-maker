//! The only place that reads the time.

use rules::Clock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The wall clock: what the running service goes by.
#[derive(Debug)]
pub struct SystemClock {
    started: Instant,
}

impl SystemClock {
    /// The clock, started now.
    pub fn new() -> Self {
        Self { started: Instant::now() }
    }
}

impl Clock for SystemClock {
    fn now(&self) -> f64 {
        // absent-ok: a clock set before 1970 has no time to tell, and 0 is that moment.
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64())
    }

    fn ticks(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    fn sleep(&self, seconds: f64) {
        thread::sleep(Duration::from_secs_f64(seconds.max(0.0)));
    }
}

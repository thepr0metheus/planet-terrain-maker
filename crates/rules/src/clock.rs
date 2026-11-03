//! Time as a parameter.

use std::sync::{Mutex, PoisonError};

/// The time, for whoever needs it: the running service has the real one, a test its own.
pub trait Clock: Send + Sync {
    /// Seconds since 1970.
    fn now(&self) -> f64;

    /// Seconds from any start, that never go back: for a wait.
    fn ticks(&self) -> f64;

    /// Waits this many seconds.
    fn sleep(&self, seconds: f64);
}

/// A clock that moves only when told to, or when something waits on it: for tests.
#[derive(Debug)]
pub struct StillClock {
    now: Mutex<f64>,
}

impl StillClock {
    /// A clock that stands at this time.
    pub fn at(now: f64) -> Self {
        Self { now: Mutex::new(now) }
    }

    /// Moves it on.
    pub fn pass(&self, seconds: f64) {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) += seconds;
    }
}

impl Clock for StillClock {
    fn now(&self) -> f64 {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ticks(&self) -> f64 {
        self.now()
    }

    fn sleep(&self, seconds: f64) {
        self.pass(seconds);
    }
}

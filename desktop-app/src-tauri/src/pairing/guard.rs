//! Who may put a pairing dialog on this screen, and when.
//!
//! Anyone on the network can ask to pair, anywhere, at any time -- that is
//! deliberate. What this stops is the asking becoming a nuisance:
//!
//! - **One ceremony at a time.** While a code is on screen (asked of us, or
//!   started by us), other devices are told we are busy instead of replacing
//!   it. Two overlapping requests made the codes look like they did not match.
//! - **Escalating cooldown.** Each rejection mutes that device for longer:
//!   1 min, 5 min, 30 min, 2 h, then 24 h. Keyed by device id *and* address,
//!   since a new device id costs nothing to make; the address cooldown is
//!   capped lower because networks hand old addresses to new devices.
//!
//! In memory only: a restart forgives everyone, which is fine for a nuisance
//! guard. Mirrors `PairingGuard.kt` on the phone, rule for rule.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A ceremony left open this long no longer holds the screen.
const ACTIVE_FOR: Duration = Duration::from_secs(120);

/// Cooldown after the 1st, 2nd, ... rejection; the last repeats.
const COOLDOWNS: [Duration; 5] = [
    Duration::from_secs(60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(30 * 60),
    Duration::from_secs(2 * 60 * 60),
    Duration::from_secs(24 * 60 * 60),
];

/// Addresses get reassigned, so an address is never muted longer than this.
const ADDR_COOLDOWN_CAP: Duration = Duration::from_secs(30 * 60);

/// Strikes are forgotten this long after the cooldown they earned ends.
const FORGIVE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, PartialEq, Eq)]
pub enum Admit {
    Ok,
    /// Another device's code is on screen.
    Busy,
    /// Declined recently; ask again after this long.
    CoolingDown(Duration),
}

struct Active {
    device_id: String,
    /// Where an incoming request came from; `None` when we started it.
    ip: Option<String>,
    until: Instant,
}

struct Strikes {
    count: usize,
    muted_until: Instant,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    strikes: HashMap<String, Strikes>,
}

#[derive(Default)]
pub struct PairingGuard(Mutex<State>);

/// The process-wide guard: the server admits requests, commands settle them.
pub fn guard() -> &'static PairingGuard {
    static GUARD: OnceLock<PairingGuard> = OnceLock::new();
    GUARD.get_or_init(PairingGuard::default)
}

fn id_key(device_id: &str) -> String {
    format!("id:{device_id}")
}

fn ip_key(ip: &str) -> String {
    format!("ip:{ip}")
}

impl State {
    fn active_at(&mut self, now: Instant) -> Option<&Active> {
        if self.active.as_ref().is_some_and(|a| a.until <= now) {
            self.active = None;
        }
        self.active.as_ref()
    }

    fn muted_for(&mut self, key: &str, now: Instant) -> Option<Duration> {
        let s = self.strikes.get(key)?;
        if now >= s.muted_until + FORGIVE_AFTER {
            self.strikes.remove(key);
            return None;
        }
        (s.muted_until > now).then(|| s.muted_until - now)
    }

    fn strike(&mut self, key: String, cap: Option<Duration>, now: Instant) {
        let count = match self.strikes.get(&key) {
            Some(s) if now < s.muted_until + FORGIVE_AFTER => s.count + 1,
            _ => 1,
        };
        let mut cooldown = COOLDOWNS[(count - 1).min(COOLDOWNS.len() - 1)];
        if let Some(cap) = cap {
            cooldown = cooldown.min(cap);
        }
        self.strikes.insert(key, Strikes { count, muted_until: now + cooldown });
    }
}

impl PairingGuard {
    /// May `device_id`, asking from `ip`, open a pairing dialog here? On
    /// `Ok` its ceremony now holds the screen.
    pub fn admit(&self, device_id: &str, ip: &str, now: Instant) -> Admit {
        let mut s = self.0.lock().unwrap();
        let muted = [id_key(device_id), ip_key(ip)]
            .iter()
            .filter_map(|k| s.muted_for(k, now))
            .max();
        if let Some(left) = muted {
            return Admit::CoolingDown(left);
        }
        if s.active_at(now).is_some_and(|a| a.device_id != device_id) {
            return Admit::Busy;
        }
        s.active = Some(Active {
            device_id: device_id.to_owned(),
            ip: Some(ip.to_owned()),
            until: now + ACTIVE_FOR,
        });
        Admit::Ok
    }

    /// The user here started pairing with `device_id`: hold the screen for it.
    pub fn begin_outgoing(&self, device_id: &str, now: Instant) {
        self.0.lock().unwrap().active = Some(Active {
            device_id: device_id.to_owned(),
            ip: None,
            until: now + ACTIVE_FOR,
        });
    }

    /// The user here rejected the codes. A device that asked us earns a
    /// strike; one we asked did nothing wrong.
    pub fn decline(&self, device_id: &str, now: Instant) {
        let mut s = self.0.lock().unwrap();
        let Some(active) = s.active.take_if(|a| a.device_id == device_id) else {
            return;
        };
        if let Some(ip) = active.ip {
            s.strike(id_key(device_id), None, now);
            s.strike(ip_key(&ip), Some(ADDR_COOLDOWN_CAP), now);
        }
    }

    /// Paired: forgive the device and free the screen.
    pub fn paired(&self, device_id: &str) {
        let mut s = self.0.lock().unwrap();
        if let Some(active) = s.active.take_if(|a| a.device_id == device_id) {
            if let Some(ip) = active.ip {
                s.strikes.remove(&ip_key(&ip));
            }
        }
        s.strikes.remove(&id_key(device_id));
    }

    /// The other device withdrew: free the screen, no strike.
    pub fn withdrawn(&self, device_id: &str) {
        let mut s = self.0.lock().unwrap();
        s.active.take_if(|a| a.device_id == device_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn second_device_is_busy_until_the_first_is_settled() {
        let g = PairingGuard::default();
        let t = Instant::now();
        assert_eq!(g.admit("a", "10.0.0.2", t), Admit::Ok);
        assert_eq!(g.admit("b", "10.0.0.3", t), Admit::Busy);
        // The same device asking again is a retry, not a second ceremony.
        assert_eq!(g.admit("a", "10.0.0.2", t), Admit::Ok);
        g.paired("a");
        assert_eq!(g.admit("b", "10.0.0.3", t), Admit::Ok);
    }

    #[test]
    fn an_abandoned_ceremony_frees_the_screen() {
        let g = PairingGuard::default();
        let t = Instant::now();
        g.admit("a", "10.0.0.2", t);
        assert_eq!(g.admit("b", "10.0.0.3", t + ACTIVE_FOR), Admit::Ok);
    }

    #[test]
    fn our_own_pairing_makes_others_wait() {
        let g = PairingGuard::default();
        let t = Instant::now();
        g.begin_outgoing("a", t);
        assert_eq!(g.admit("b", "10.0.0.3", t), Admit::Busy);
        // Rejecting a device we asked is no strike against it.
        g.decline("a", t);
        assert_eq!(g.admit("a", "10.0.0.2", t), Admit::Ok);
    }

    #[test]
    fn each_rejection_mutes_for_longer() {
        let g = PairingGuard::default();
        let mut t = Instant::now();
        for want in [1, 5, 30, 120, 1440, 1440] {
            assert_eq!(g.admit("a", "10.0.0.2", t), Admit::Ok);
            g.decline("a", t);
            assert_eq!(g.admit("a", "10.0.0.9", t), Admit::CoolingDown(want * MIN));
            t += want * MIN;
        }
    }

    #[test]
    fn a_new_device_id_from_the_same_address_is_muted_too() {
        let g = PairingGuard::default();
        let t = Instant::now();
        g.admit("a", "10.0.0.2", t);
        g.decline("a", t);
        assert_eq!(g.admit("fresh", "10.0.0.2", t), Admit::CoolingDown(MIN));
        assert_eq!(g.admit("fresh", "10.0.0.3", t), Admit::Ok);
    }

    #[test]
    fn an_address_is_never_muted_past_the_cap() {
        let g = PairingGuard::default();
        let mut t = Instant::now();
        for _ in 0..5 {
            g.admit("a", "10.0.0.2", t);
            g.decline("a", t);
            t += COOLDOWNS[4];
        }
        g.admit("a", "10.0.0.2", t);
        g.decline("a", t);
        assert_eq!(g.admit("other", "10.0.0.2", t), Admit::CoolingDown(ADDR_COOLDOWN_CAP));
    }

    #[test]
    fn pairing_or_a_quiet_day_forgives() {
        let g = PairingGuard::default();
        let t = Instant::now();
        g.admit("a", "10.0.0.2", t);
        g.decline("a", t);
        g.admit("a", "10.0.0.2", t + MIN);
        g.paired("a");
        g.admit("a", "10.0.0.2", t + MIN);
        g.decline("a", t + MIN);
        // Back to the first step, not the second.
        assert_eq!(g.admit("a", "10.0.0.2", t + MIN), Admit::CoolingDown(MIN));

        let later = t + 2 * MIN + FORGIVE_AFTER;
        assert_eq!(g.admit("a", "10.0.0.2", later), Admit::Ok);
        g.decline("a", later);
        assert_eq!(g.admit("a", "10.0.0.2", later), Admit::CoolingDown(MIN));
    }

    #[test]
    fn withdrawal_frees_the_screen_without_a_strike() {
        let g = PairingGuard::default();
        let t = Instant::now();
        g.admit("a", "10.0.0.2", t);
        g.withdrawn("a");
        assert_eq!(g.admit("b", "10.0.0.3", t), Admit::Ok);
        g.withdrawn("b");
        assert_eq!(g.admit("a", "10.0.0.2", t), Admit::Ok);
    }
}

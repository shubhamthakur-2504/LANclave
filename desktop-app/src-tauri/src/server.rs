use std::path::PathBuf;
use std::sync::Arc;

use crate::pairing::AuthState;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Application state, shared across all Axum handlers via `axum::extract::State`.
#[derive(Clone)]
pub struct AppState {
    pub sandbox_root: PathBuf,
    /// Authentication state — shared device store behind an `RwLock`.
    pub auth: Arc<AuthState>,
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

/// Build the Axum router with all file‑server routes.
///
/// Auth checks run **inside** the handler functions (via
/// [`check_request`](crate::pairing::check_request)) rather than as generic
/// middleware because axum 0.8's generic `from_fn` middleware has
/// incompatible type constraints with the handler extractors.  The end
/// result is identical — unauthenticated requests receive a 401 before any
/// file I/O occurs.
pub fn build_router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route(
            "/files/{*path}",
            axum::routing::get(crate::files::download_file)
                .put(crate::files::upload_file),
        )
        .with_state(state)
}

/// Alias of [`build_router`].  Exists so that test helpers that bypass auth
/// can call this (they construct an `AppState` with [`AuthState::disabled`]).
pub fn build_raw_router(state: Arc<AppState>) -> axum::Router {
    build_router(state)
}

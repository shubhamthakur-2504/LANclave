use std::path::PathBuf;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Application state, shared across all Axum handlers via `axum::extract::State`.
#[derive(Clone)]
pub struct AppState {
    pub sandbox_root: PathBuf,
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Build an Axum router with all file‑server routes wired to `state`.
pub fn build_router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new()
        .route(
            "/files/{*path}",
            axum::routing::get(crate::files::download_file)
                .put(crate::files::upload_file),
        )
        .with_state(state)
}

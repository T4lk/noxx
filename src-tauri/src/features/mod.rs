//! Feature modules. Each one owns its own file(s) and is reached from the UI
//! through one generic command: `invoke('feature', { name: 'module.cmd', args })`
//! (in JS: `riff.call('module.cmd', args)`).
//!
//! A module exposes:
//!   pub fn setup(app: &AppHandle)            – run once at startup (spawn tasks here)
//!   pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> Result<Value, String>
//!
//! Shared state: `app.state::<crate::AppState>()` gives `sc` (SoundCloud client),
//! `lib` (Mutex<Library>), `data_dir`. Events to the UI: `app.emit("name", payload)`.

use serde_json::Value;
use tauri::AppHandle;

pub mod about;
pub mod discord;
pub mod discover;
pub mod downloads;
pub mod history;
pub mod imports;
pub mod localfiles;
pub mod lyrics;
pub mod mixes;
pub mod system;
pub mod themes;
pub mod youtube;

pub type Out = Result<Value, String>;

pub async fn dispatch(app: &AppHandle, name: &str, args: Value) -> Out {
    let (module, cmd) = name.split_once('.').ok_or_else(|| format!("bad feature call: {name}"))?;
    match module {
        "about" => about::handle(app, cmd, args).await,
        "discord" => discord::handle(app, cmd, args).await,
        "discover" => discover::handle(app, cmd, args).await,
        "downloads" => downloads::handle(app, cmd, args).await,
        "history" => history::handle(app, cmd, args).await,
        "imports" => imports::handle(app, cmd, args).await,
        "localfiles" => localfiles::handle(app, cmd, args).await,
        "lyrics" => lyrics::handle(app, cmd, args).await,
        "mixes" => mixes::handle(app, cmd, args).await,
        "system" => system::handle(app, cmd, args).await,
        "themes" => themes::handle(app, cmd, args).await,
        "youtube" => youtube::handle(app, cmd, args).await,
        _ => Err(format!("unknown feature: {module}")),
    }
}

pub fn setup(app: &AppHandle) {
    about::setup(app);
    discord::setup(app);
    discover::setup(app);
    downloads::setup(app);
    history::setup(app);
    imports::setup(app);
    localfiles::setup(app);
    lyrics::setup(app);
    mixes::setup(app);
    system::setup(app);
    themes::setup(app);
    youtube::setup(app);
}

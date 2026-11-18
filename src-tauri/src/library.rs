//! Local library: favorites (which mirror SoundCloud likes) and local playlists.
//! Saved as one JSON file in the app data folder.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::soundcloud::{write_json, Track};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPlaylist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryData {
    /// Newest first. SoundCloud likes come first in SoundCloud's order,
    /// followed by tracks hearted only inside the app.
    #[serde(default)]
    pub favorites: Vec<Track>,
    #[serde(default)]
    pub playlists: Vec<LocalPlaylist>,
    /// Track ids that came from the last SoundCloud likes sync. Used to tell
    /// "unliked on SoundCloud" apart from "hearted locally".
    #[serde(default)]
    pub synced_like_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct SyncResult {
    pub added: usize,
    pub removed: usize,
    pub changed: bool,
}

pub struct Library {
    path: PathBuf,
    pub data: LibraryData,
}

impl Library {
    pub fn load(dir: &PathBuf) -> Self {
        let path = dir.join("library.json");
        let data = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, data }
    }

    fn save(&self) {
        write_json(&self.path, &self.data);
    }

    pub fn is_favorite(&self, id: &str) -> bool {
        self.data.favorites.iter().any(|t| t.id == id)
    }

    /// Returns true when the track is now a favorite.
    pub fn toggle_favorite(&mut self, track: Track) -> bool {
        let now_fav = if let Some(pos) = self.data.favorites.iter().position(|t| t.id == track.id) {
            self.data.favorites.remove(pos);
            false
        } else {
            self.data.favorites.insert(0, track);
            true
        };
        self.save();
        now_fav
    }

    /// After a heart was pushed to SoundCloud: track whether the id now counts as a synced like,
    /// so a later unlike on soundcloud.com removes it here too.
    pub fn mark_synced_like(&mut self, id: &str, liked: bool) {
        let ids = &mut self.data.synced_like_ids;
        ids.retain(|x| x != id);
        if liked {
            ids.insert(0, id.to_string());
        }
        self.save();
    }

    /// Mirror SoundCloud likes into favorites:
    /// liked tracks first in SoundCloud's order (newest like on top), then
    /// favorites that never came from SoundCloud. Tracks that came from an
    /// earlier sync but are no longer liked are removed.
    pub fn apply_likes(&mut self, liked: Vec<Track>) -> SyncResult {
        let liked_ids: Vec<String> = liked.iter().map(|t| t.id.clone()).collect();
        let liked_set: HashSet<&str> = liked_ids.iter().map(String::as_str).collect();
        let prev_set: HashSet<&str> = self.data.synced_like_ids.iter().map(String::as_str).collect();
        let existing: HashMap<&str, ()> = self.data.favorites.iter().map(|t| (t.id.as_str(), ())).collect();

        let added = liked.iter().filter(|t| !existing.contains_key(t.id.as_str())).count();
        let others: Vec<Track> = self
            .data
            .favorites
            .iter()
            .filter(|t| !liked_set.contains(t.id.as_str()) && !prev_set.contains(t.id.as_str()))
            .cloned()
            .collect();
        let kept_liked = liked.len() - added;
        let removed = self.data.favorites.len().saturating_sub(others.len() + kept_liked);

        let before: Vec<String> = self.data.favorites.iter().map(|t| t.id.clone()).collect();
        // Fresh SoundCloud metadata replaces whatever was saved before.
        let mut next = liked;
        next.extend(others);
        let after: Vec<String> = next.iter().map(|t| t.id.clone()).collect();
        let changed = before != after;

        self.data.favorites = next;
        self.data.synced_like_ids = liked_ids;
        self.save();
        SyncResult { added, removed, changed }
    }

    pub fn create_playlist(&mut self, name: &str) -> LocalPlaylist {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0).to_string();
        let name = if name.trim().is_empty() { "New playlist".to_string() } else { name.trim().to_string() };
        let pl = LocalPlaylist { id, name, tracks: Vec::new() };
        self.data.playlists.push(pl.clone());
        self.save();
        pl
    }

    pub fn delete_playlist(&mut self, id: &str) {
        self.data.playlists.retain(|p| p.id != id);
        self.save();
    }

    pub fn rename_playlist(&mut self, id: &str, name: &str) {
        if let Some(p) = self.data.playlists.iter_mut().find(|p| p.id == id) {
            if !name.trim().is_empty() {
                p.name = name.trim().to_string();
                self.save();
            }
        }
    }

    /// Returns false when the track was already in the playlist.
    pub fn add_to_playlist(&mut self, id: &str, track: Track) -> bool {
        let Some(p) = self.data.playlists.iter_mut().find(|p| p.id == id) else { return false };
        if p.tracks.iter().any(|t| t.id == track.id) {
            return false;
        }
        p.tracks.push(track);
        self.save();
        true
    }

    /// Appends the tracks not already in the playlist, with one save. Returns how many were added.
    pub fn add_many(&mut self, id: &str, tracks: Vec<Track>) -> usize {
        let Some(p) = self.data.playlists.iter_mut().find(|p| p.id == id) else { return 0 };
        let mut have: HashSet<String> = p.tracks.iter().map(|t| t.id.clone()).collect();
        let before = p.tracks.len();
        p.tracks.extend(tracks.into_iter().filter(|t| have.insert(t.id.clone())));
        let added = p.tracks.len() - before;
        if added > 0 {
            self.save();
        }
        added
    }

    pub fn remove_from_playlist(&mut self, id: &str, track_id: &str) {
        if let Some(p) = self.data.playlists.iter_mut().find(|p| p.id == id) {
            p.tracks.retain(|t| t.id != track_id);
            self.save();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> Track {
        Track { id: id.into(), title: id.into(), artist: "a".into(), duration: 1, artwork: String::new(), url: String::new(), artist_id: String::new(), artist_url: String::new(), genre: String::new(), style: String::new(), source: String::new(), path: String::new() }
    }

    fn ids(lib: &Library) -> Vec<&str> {
        lib.data.favorites.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn likes_mirror_order_removals_and_keep_local() {
        let dir = std::env::temp_dir().join(format!("riff-rs-test-{}", std::process::id()));
        let mut lib = Library { path: dir.join("library.json"), data: LibraryData::default() };
        lib.toggle_favorite(t("local"));

        let r = lib.apply_likes(vec![t("3"), t("2"), t("1")]);
        assert_eq!((r.added, r.removed), (3, 0));
        assert_eq!(ids(&lib), vec!["3", "2", "1", "local"]);

        // "2" unliked on SoundCloud, "4" newly liked.
        let r = lib.apply_likes(vec![t("4"), t("3"), t("1")]);
        assert_eq!((r.added, r.removed), (1, 1));
        assert_eq!(ids(&lib), vec!["4", "3", "1", "local"]);

        // Same likes again: nothing changes.
        let r = lib.apply_likes(vec![t("4"), t("3"), t("1")]);
        assert!(!r.changed);
        let _ = std::fs::remove_dir_all(dir);
    }
}

use sqlx::SqlitePool;
use tracing::info;

pub async fn run_migrations(db: &SqlitePool) {

    sqlx::query("PRAGMA journal_mode=WAL")
        .execute(db)
        .await
        .expect("Failed to enable WAL");

    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(db)
        .await
        .expect("Failed to enable foreign keys");


    sqlx::query(
        "CREATE TABLE IF NOT EXISTS snippets (
            id          TEXT PRIMARY KEY,
            slug        TEXT NOT NULL UNIQUE,
            content     TEXT NOT NULL DEFAULT '',
            language    TEXT NOT NULL DEFAULT 'javascript',
            images      TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL,
            expires_at  TEXT NOT NULL
        )"
    )
    .execute(db)
    .await
    .expect("Failed to create snippets table");


    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_snippets_slug ON snippets(slug)"
    )
    .execute(db)
    .await
    .expect("Failed to create slug index");


    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_snippets_expires ON snippets(expires_at)"
    )
    .execute(db)
    .await
    .expect("Failed to create expires index");

    info!("Migrations complete");
}
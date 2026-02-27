use sqlx::PgPool;
use tracing::info;

pub async fn run_migrations(db: &PgPool) {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'javascript',
            images JSONB NOT NULL DEFAULT '[]',
            created_at TIMESTAMP NOT NULL,
            expires_at TIMESTAMP NOT NULL
        );
        "#
    )
    .execute(db)
    .await
    .expect("Failed to create snippets table");

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_snippets_slug ON snippets(slug)")
        .execute(db)
        .await
        .unwrap();

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_snippets_expires ON snippets(expires_at)")
        .execute(db)
        .await
        .unwrap();

    info!("Postgres migrations complete");
}
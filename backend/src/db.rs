use mongodb::{
    bson::doc,
    options::{ClientOptions, IndexOptions},
    Client, Database, IndexModel,
};
use tracing::info;

pub async fn get_database() -> Database {
    let mongo_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set");

    let mut opts = ClientOptions::parse(&mongo_url)
        .await
        .expect("Failed to parse MongoDB URL");

    opts.app_name = Some("backend".into());

    let client = Client::with_options(opts).expect("Failed to create MongoDB client");
    let db_name = std::env::var("MONGODB_DB").unwrap_or_else(|_| "snippets_db".into());
    let db = client.database(&db_name);

    run_migrations(&db).await;
    db
}

pub async fn run_migrations(db: &Database) {
    let col = db.collection::<mongodb::bson::Document>("snippets");

    let slug_idx = IndexModel::builder()
        .keys(doc! { "slug": 1 })
        .options(
            IndexOptions::builder()
                .unique(true)
                .name("idx_snippets_slug".to_string())
                .build(),
        )
        .build();

    let expires_idx = IndexModel::builder()
        .keys(doc! { "expires_at": 1 })
        .options(
            IndexOptions::builder()
                .name("idx_snippets_expires".to_string())
                .build(),
        )
        .build();

    col.create_index(slug_idx)
        .await
        .expect("Failed to create slug index");

    col.create_index(expires_idx)
        .await
        .expect("Failed to create expires_at index");

    info!("MongoDB indexes ready");
}
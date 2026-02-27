use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post, delete},
    Router,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use regex::Regex;

mod db;
mod error;

use error::AppError;



#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
}

// ─── Models ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Snippet {
    pub id: String,
    pub slug: String,
    pub content: String,         
    pub language: String,
    pub images: String,           
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSnippetRequest {
    pub slug: Option<String>,     
    pub content: String,
    pub language: Option<String>,
    pub images: Option<Vec<ImageData>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageData {
    pub id: String,
    pub data_url: String,       
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct SnippetResponse {
    pub slug: String,
    pub content: String,
    pub language: String,
    pub images: Vec<ImageData>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub slug: String,
    pub url: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct SlugCheckResponse {
    pub available: bool,
    pub slug: String,
}



fn validate_slug(slug: &str) -> Result<(), AppError> {
    if slug.is_empty() {
        return Err(AppError::BadRequest("Slug cannot be empty".into()));
    }
    if slug.len() < 3 {
        return Err(AppError::BadRequest("Slug must be at least 3 characters".into()));
    }
    if slug.len() > 60 {
        return Err(AppError::BadRequest("Slug must be 60 characters or less".into()));
    }

    let re = Regex::new(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$").unwrap();
    if !re.is_match(slug) {
        return Err(AppError::BadRequest(
            "Slug can only contain lowercase letters, numbers, and hyphens. Must start and end with a letter or number.".into()
        ));
    }

    // Reserved slugs
    let reserved = ["api", "admin", "health", "static", "assets", "new", "create", "share"];
    if reserved.contains(&slug) {
        return Err(AppError::BadRequest("This slug is reserved. Please choose another.".into()));
    }

    Ok(())
}

fn sanitize_slug(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn generate_slug() -> String {
    nanoid::nanoid!(8, &nanoid::alphabet::SAFE)
}


/// POST /api/snippets
/// Create a new snippet with optional custom slug
async fn create_snippet(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSnippetRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Determine slug
    let slug = match &req.slug {
        Some(raw) if !raw.trim().is_empty() => {
            let s = sanitize_slug(raw.trim());
            validate_slug(&s)?;

            // Check slug availability
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = ? AND expires_at > datetime('now'))"
            )
            .bind(&s)
            .fetch_one(&state.db)
            .await
            .map_err(AppError::Db)?;

            if exists {
                return Err(AppError::Conflict("This URL is already taken. Please choose another.".into()));
            }
            s
        }
        _ => {
          
            let mut slug = generate_slug();
            for _ in 0..10 {
                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = ? AND expires_at > datetime('now'))"
                )
                .bind(&slug)
                .fetch_one(&state.db)
                .await
                .map_err(AppError::Db)?;

                if !exists { break; }
                slug = generate_slug();
            }
            slug
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let language = req.language.unwrap_or_else(|| "javascript".to_string());
    let now = Utc::now();
    let expires_at = now + Duration::hours(24);

    // Serialize images to JSON
    let images_json = match &req.images {
        Some(imgs) => serde_json::to_string(imgs).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    };

    sqlx::query(
        "INSERT INTO snippets (id, slug, content, language, images, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&slug)
    .bind(&req.content)
    .bind(&language)
    .bind(&images_json)
    .bind(now)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(AppError::Db)?;

    info!("Created snippet: {} (expires: {})", slug, expires_at);

    Ok((
        StatusCode::CREATED,
        Json(CreateResponse {
            slug: slug.clone(),
            url: format!("/{}", slug),
            expires_at,
        }),
    ))
}

async fn get_snippet(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = sqlx::query_as::<_, Snippet>(
        "SELECT id, slug, content, language, images, created_at, expires_at
         FROM snippets
         WHERE slug = ? AND expires_at > datetime('now')"
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::Db)?;

    match row {
        None => Err(AppError::NotFound("Snippet not found or expired".into())),
        Some(snippet) => {
            let images: Vec<ImageData> = serde_json::from_str(&snippet.images)
                .unwrap_or_default();

            Ok(Json(SnippetResponse {
                url: format!("/{}", snippet.slug),
                slug: snippet.slug,
                content: snippet.content,
                language: snippet.language,
                images,
                created_at: snippet.created_at,
                expires_at: snippet.expires_at,
            }))
        }
    }
}


async fn check_slug(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let s = sanitize_slug(&slug);

 
    if let Err(_) = validate_slug(&s) {
        return Ok(Json(SlugCheckResponse { available: false, slug: s }));
    }

    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = ? AND expires_at > datetime('now'))"
    )
    .bind(&s)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::Db)?;

    Ok(Json(SlugCheckResponse {
        available: !exists,
        slug: s,
    }))
}


async fn delete_snippet(
    State(state): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let result = sqlx::query("DELETE FROM snippets WHERE slug = ?")
        .bind(&slug)
        .execute(&state.db)
        .await
        .map_err(AppError::Db)?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Snippet not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}


async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}



async fn cleanup_expired(db: SqlitePool) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
        match sqlx::query("DELETE FROM snippets WHERE expires_at <= datetime('now')")
            .execute(&db)
            .await
        {
            Ok(r) => info!("Cleanup: deleted {} expired snippets", r.rows_affected()),
            Err(e) => tracing::error!("Cleanup error: {}", e),
        }
    }
}



#[tokio::main]
async fn main() {

    dotenvy::dotenv().ok();


    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "codeshare_backend=info,tower_http=info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://codeshare.db".to_string());
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3001".to_string())
        .parse()
        .expect("PORT must be a number");
    let frontend_url = std::env::var("FRONTEND_URL")
        .unwrap_or_else(|_| "http://localhost:5173".to_string());


    let db = SqlitePoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("Failed to connect to SQLite");


    db::run_migrations(&db).await;

    info!("Database ready");

    let state = Arc::new(AppState { db: db.clone() });

  
    tokio::spawn(cleanup_expired(db.clone()));

  
    let cors = CorsLayer::new()
        .allow_origin(frontend_url.parse::<axum::http::HeaderValue>().unwrap())
        .allow_methods(Any)
        .allow_headers(Any);

 
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/snippets", post(create_snippet))
        .route("/api/snippets/:slug", get(get_snippet))
        .route("/api/snippets/:slug", delete(delete_snippet))
        .route("/api/check/:slug", get(check_slug))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    info!("Server running on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
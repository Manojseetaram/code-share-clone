use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{delete, get, post},
    Router,
};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::{str::FromStr, sync::Arc};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

// ─── Room: one broadcast channel per snippet slug ─────────────────────────

type Rooms = Arc<DashMap<String, broadcast::Sender<String>>>;

fn get_or_create_room(rooms: &Rooms, slug: &str) -> broadcast::Sender<String> {
    if let Some(tx) = rooms.get(slug) {
        return tx.clone();
    }
    let (tx, _) = broadcast::channel(64);
    rooms.insert(slug.to_string(), tx.clone());
    tx
}

// ─── App State ────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub rooms: Rooms,
}

// ─── DB Models ────────────────────────────────────────────────────────────

#[derive(Debug, sqlx::FromRow)]
pub struct SnippetRow {
    pub slug: String,
    pub content: String,
    pub language: String,
    pub images: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

// ─── API Types ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
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
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub slug: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct SlugCheck {
    pub available: bool,
    pub slug: String,
}

// WebSocket message that clients send/receive
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    // Client → Server: user typed
    Edit { content: String, language: String },
    // Client → Server: user pasted image
    Image { image: ImageData },
    // Client → Server: user removed image
    RemoveImage { id: String },
    // Server → Client: broadcast edit to all others
    BroadcastEdit { content: String, language: String },
    // Server → Client: broadcast image
    BroadcastImage { image: ImageData },
    // Server → Client: broadcast remove image
    BroadcastRemoveImage { id: String },
    // Server → Client: connected
    Connected { slug: String, viewers: usize },
    // Server → Client: viewer count changed
    Viewers { count: usize },
}

// ─── Error ────────────────────────────────────────────────────────────────

enum AppError {
    NotFound(String),
    BadRequest(String),
    Conflict(String),
    Db(sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::Db(e) => {
                tracing::error!("DB: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// ─── Slug helpers ─────────────────────────────────────────────────────────

fn sanitize(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn validate(slug: &str) -> Result<(), AppError> {
    if slug.len() < 3 { return Err(AppError::BadRequest("Slug must be ≥ 3 characters".into())); }
    if slug.len() > 60 { return Err(AppError::BadRequest("Slug must be ≤ 60 characters".into())); }
    let re = Regex::new(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$").unwrap();
    if !re.is_match(slug) {
        return Err(AppError::BadRequest("Only lowercase letters, numbers, hyphens. No leading/trailing hyphens.".into()));
    }
    for r in &["api", "admin", "health", "ws", "new", "static"] {
        if *r == slug { return Err(AppError::BadRequest(format!("'{slug}' is reserved"))); }
    }
    Ok(())
}

fn gen_slug() -> String {
    nanoid::nanoid!(8, &nanoid::alphabet::SAFE)
}

// ─── Handlers ─────────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

/// GET /api/check/:slug  — real-time slug availability
async fn check_slug(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
) -> impl IntoResponse {
    let slug = sanitize(&raw);
    let valid = validate(&slug).is_ok();
    let taken: bool = if valid {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug=? AND expires_at > datetime('now'))",
        )
        .bind(&slug)
        .fetch_one(&s.db)
        .await
        .unwrap_or(false)
    } else {
        true
    };
    Json(SlugCheck { available: valid && !taken, slug })
}

/// POST /api/snippets
async fn create_snippet(
    State(s): State<Arc<AppState>>,
    Json(req): Json<CreateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let slug = match req.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let sl = sanitize(raw);
            validate(&sl)?;
            let taken: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug=? AND expires_at > datetime('now'))",
            )
            .bind(&sl)
            .fetch_one(&s.db)
            .await
            .map_err(AppError::Db)?;
            if taken { return Err(AppError::Conflict("URL already taken".into())); }
            sl
        }
        None => {
            let mut sl = gen_slug();
            for _ in 0..10 {
                let taken: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug=? AND expires_at > datetime('now'))",
                )
                .bind(&sl)
                .fetch_one(&s.db)
                .await
                .map_err(AppError::Db)?;
                if !taken { break; }
                sl = gen_slug();
            }
            sl
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let lang = req.language.unwrap_or_else(|| "javascript".into());
    let now = Utc::now();
    let expires = now + Duration::hours(24);
    let images_json = req.images
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    sqlx::query(
        "INSERT INTO snippets (id,slug,content,language,images,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(&id).bind(&slug).bind(&req.content).bind(&lang)
    .bind(&images_json).bind(now).bind(expires)
    .execute(&s.db)
    .await
    .map_err(AppError::Db)?;

    info!("created /{slug}");
    Ok((StatusCode::CREATED, Json(CreateResponse { slug, expires_at: expires })))
}

/// GET /api/snippets/:slug
async fn get_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = sqlx::query_as::<_, SnippetRow>(
        "SELECT slug,content,language,images,created_at,expires_at
         FROM snippets WHERE slug=? AND expires_at > datetime('now')",
    )
    .bind(&slug)
    .fetch_optional(&s.db)
    .await
    .map_err(AppError::Db)?
    .ok_or_else(|| AppError::NotFound("Snippet not found or expired".into()))?;

    let images: Vec<ImageData> = serde_json::from_str(&row.images).unwrap_or_default();
    Ok(Json(SnippetResponse {
        slug: row.slug,
        content: row.content,
        language: row.language,
        images,
        created_at: row.created_at,
        expires_at: row.expires_at,
    }))
}

/// PATCH /api/snippets/:slug  — save latest content (called on WS edit)
#[derive(Deserialize)]
struct PatchRequest {
    content: Option<String>,
    language: Option<String>,
    images: Option<Vec<ImageData>>,
}

async fn patch_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(req): Json<PatchRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Update only fields that are provided
    if let Some(ref content) = req.content {
        sqlx::query("UPDATE snippets SET content=? WHERE slug=? AND expires_at > datetime('now')")
            .bind(content).bind(&slug)
            .execute(&s.db).await.map_err(AppError::Db)?;
    }
    if let Some(ref lang) = req.language {
        sqlx::query("UPDATE snippets SET language=? WHERE slug=? AND expires_at > datetime('now')")
            .bind(lang).bind(&slug)
            .execute(&s.db).await.map_err(AppError::Db)?;
    }
    if let Some(ref imgs) = req.images {
        let json = serde_json::to_string(imgs).unwrap_or_else(|_| "[]".into());
        sqlx::query("UPDATE snippets SET images=? WHERE slug=? AND expires_at > datetime('now')")
            .bind(json).bind(&slug)
            .execute(&s.db).await.map_err(AppError::Db)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /api/snippets/:slug
async fn delete_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM snippets WHERE slug=?")
        .bind(&slug).execute(&s.db).await.map_err(AppError::Db)?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /ws/:slug  — WebSocket upgrade
async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(slug): Path<String>,
    State(s): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, slug, s))
}

async fn handle_ws(socket: WebSocket, slug: String, state: Arc<AppState>) {
    let tx = get_or_create_room(&state.rooms, &slug);
    let mut rx = tx.subscribe();
    let viewer_count = tx.receiver_count();

    let (mut sender, mut receiver) = socket.split();

    // Tell this client they're connected
    let connected_msg = serde_json::to_string(&WsMessage::Connected {
        slug: slug.clone(),
        viewers: viewer_count,
    })
    .unwrap();
    let _ = sender.send(Message::Text(connected_msg.into())).await;

    // Broadcast new viewer count to everyone else
    let viewers_msg = serde_json::to_string(&WsMessage::Viewers { count: viewer_count + 1 }).unwrap();
    let _ = tx.send(viewers_msg);

    let slug_clone = slug.clone();
    let state_clone = state.clone();
    let tx_clone = tx.clone();

    // Task: receive from client → broadcast to room + persist
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };

            let ws_msg: WsMessage = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };

            match ws_msg {
                WsMessage::Edit { ref content, ref language } => {
                    // Persist to DB (debounced by client)
                    let _ = sqlx::query(
                        "UPDATE snippets SET content=?, language=? WHERE slug=? AND expires_at > datetime('now')"
                    )
                    .bind(content).bind(language).bind(&slug_clone)
                    .execute(&state_clone.db).await;

                    // Broadcast to others
                    let broadcast = serde_json::to_string(&WsMessage::BroadcastEdit {
                        content: content.clone(),
                        language: language.clone(),
                    }).unwrap();
                    let _ = tx_clone.send(broadcast);
                }
                WsMessage::Image { ref image } => {
                    // Add image to DB
                    let row = sqlx::query_scalar::<_, String>(
                        "SELECT images FROM snippets WHERE slug=? AND expires_at > datetime('now')"
                    )
                    .bind(&slug_clone)
                    .fetch_optional(&state_clone.db).await.ok().flatten().unwrap_or_else(|| "[]".into());

                    let mut imgs: Vec<ImageData> = serde_json::from_str(&row).unwrap_or_default();
                    imgs.push(image.clone());
                    let json = serde_json::to_string(&imgs).unwrap();
                    let _ = sqlx::query("UPDATE snippets SET images=? WHERE slug=?")
                        .bind(json).bind(&slug_clone)
                        .execute(&state_clone.db).await;

                    let broadcast = serde_json::to_string(&WsMessage::BroadcastImage { image: image.clone() }).unwrap();
                    let _ = tx_clone.send(broadcast);
                }
                WsMessage::RemoveImage { ref id } => {
                    let row = sqlx::query_scalar::<_, String>(
                        "SELECT images FROM snippets WHERE slug=? AND expires_at > datetime('now')"
                    )
                    .bind(&slug_clone)
                    .fetch_optional(&state_clone.db).await.ok().flatten().unwrap_or_else(|| "[]".into());

                    let mut imgs: Vec<ImageData> = serde_json::from_str(&row).unwrap_or_default();
                    imgs.retain(|i| &i.id != id);
                    let json = serde_json::to_string(&imgs).unwrap();
                    let _ = sqlx::query("UPDATE snippets SET images=? WHERE slug=?")
                        .bind(json).bind(&slug_clone)
                        .execute(&state_clone.db).await;

                    let broadcast = serde_json::to_string(&WsMessage::BroadcastRemoveImage { id: id.clone() }).unwrap();
                    let _ = tx_clone.send(broadcast);
                }
                _ => {}
            }
        }
    });

    // Task: receive from broadcast → send to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = &mut recv_task => send_task.abort(),
        _ = &mut send_task => recv_task.abort(),
    }

    // Broadcast updated viewer count on disconnect
    let remaining = tx.receiver_count().saturating_sub(1);
    let msg = serde_json::to_string(&WsMessage::Viewers { count: remaining }).unwrap();
    let _ = tx.send(msg);
    info!("ws disconnected from /{slug}");
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

async fn cleanup(db: SqlitePool) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
        match sqlx::query("DELETE FROM snippets WHERE expires_at <= datetime('now')")
            .execute(&db).await
        {
            Ok(r) => info!("cleanup: removed {} expired snippets", r.rows_affected()),
            Err(e) => tracing::error!("cleanup error: {e}"),
        }
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .init();

    let db_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://./codeshare.db".into());
    let port: u16 = std::env::var("PORT").unwrap_or_else(|_| "3001".into()).parse().unwrap_or(3001);
    let frontend = std::env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:5173".into());

    let db = SqlitePoolOptions::new()
        .max_connections(20)
        .connect_with(
            SqliteConnectOptions::from_str(&db_url)
                .expect("invalid DATABASE_URL")
                .create_if_missing(true),
        )
        .await
        .expect("failed to connect to sqlite");

    // Migrations
    sqlx::query("PRAGMA journal_mode=WAL").execute(&db).await.unwrap();
    sqlx::query("PRAGMA foreign_keys=ON").execute(&db).await.unwrap();
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'javascript',
            images TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )",
    ).execute(&db).await.unwrap();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_slug ON snippets(slug)").execute(&db).await.unwrap();
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_exp  ON snippets(expires_at)").execute(&db).await.unwrap();

    info!("database ready");

    let state = Arc::new(AppState {
        db: db.clone(),
        rooms: Arc::new(DashMap::new()),
    });

    tokio::spawn(cleanup(db));

    let cors = CorsLayer::new()
        .allow_origin(frontend.parse::<axum::http::HeaderValue>().unwrap())
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/check/:slug", get(check_slug))
        .route("/api/snippets", post(create_snippet))
        .route("/api/snippets/:slug", get(get_snippet))
        .route("/api/snippets/:slug", axum::routing::patch(patch_snippet))
        .route("/api/snippets/:slug", delete(delete_snippet))
        .route("/ws/:slug", get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
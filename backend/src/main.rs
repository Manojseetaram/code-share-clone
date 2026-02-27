use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{delete, get, post, patch},
    Router,
};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

type Rooms = Arc<DashMap<String, broadcast::Sender<String>>>;

fn get_or_create_room(rooms: &Rooms, slug: &str) -> broadcast::Sender<String> {
    if let Some(tx) = rooms.get(slug) { return tx.clone(); }
    let (tx, _) = broadcast::channel(128);
    rooms.insert(slug.to_string(), tx.clone());
    tx
}

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub rooms: Rooms,
}

#[derive(Debug, sqlx::FromRow)]
pub struct SnippetRow {
    pub slug: String,
    pub content: String,
    pub language: String,
    pub images: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

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
    pub url: String,
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

mod error;
mod db;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMsg {
    // client → server
    Edit          { content: String, language: String },
    Image         { image: ImageData },
    RemoveImage   { id: String },
    // server → client
    Connected     { slug: String, viewers: usize },
    Viewers       { count: usize },
    BroadcastEdit { content: String, language: String },
    BroadcastImage       { image: ImageData },
    BroadcastRemoveImage { id: String },
}

enum AppError {
    NotFound(String),
    BadRequest(String),
    Conflict(String),
    Db(sqlx::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            AppError::NotFound(m)   => (StatusCode::NOT_FOUND, m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Conflict(m)   => (StatusCode::CONFLICT, m),
            AppError::Db(e)         => {
                tracing::error!("db: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

fn sanitize(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn validate(slug: &str) -> Result<(), AppError> {
    if slug.len() < 3  { return Err(AppError::BadRequest("Slug must be ≥ 3 characters".into())); }
    if slug.len() > 60 { return Err(AppError::BadRequest("Slug must be ≤ 60 characters".into())); }
    let re = Regex::new(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$").unwrap();
    if !re.is_match(slug) { return Err(AppError::BadRequest("Only lowercase letters, numbers, hyphens".into())); }
    for r in &["api", "admin", "health", "ws", "new", "static", "assets"] {
        if *r == slug { return Err(AppError::BadRequest(format!("'{slug}' is reserved"))); }
    }
    Ok(())
}

fn gen_slug() -> String {
    const ALPHABET: &[char] = &[
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        '0','1','2','3','4','5','6','7','8','9',
    ];
    nanoid::nanoid!(8, ALPHABET)
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn check_slug(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
) -> impl IntoResponse {
    let slug = sanitize(&raw);
    let valid = validate(&slug).is_ok();
    let taken: bool = if valid {
        sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = $1 AND expires_at > NOW())"
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

async fn create_snippet(
    State(s): State<Arc<AppState>>,
    Json(req): Json<CreateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let slug = match req.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let sl = sanitize(raw);
            validate(&sl)?;
            let taken: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = $1 AND expires_at > NOW())"
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
                    "SELECT EXISTS(SELECT 1 FROM snippets WHERE slug = $1 AND expires_at > NOW())"
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

    let id      = uuid::Uuid::new_v4().to_string();
    let lang    = req.language.unwrap_or_else(|| "javascript".into());
    let now     = Utc::now();
    let expires = now + Duration::hours(24);
    let images_json = req.images
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    sqlx::query(
        "INSERT INTO snippets (id, slug, content, language, images, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)"
    )
    .bind(&id)
    .bind(&slug)
    .bind(&req.content)
    .bind(&lang)
    .bind(&images_json)
    .bind(now)
    .bind(expires)
    .execute(&s.db)
    .await
    .map_err(AppError::Db)?;

    info!("created /{slug}");
    Ok((StatusCode::CREATED, Json(CreateResponse { slug, expires_at: expires })))
}

async fn get_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = sqlx::query_as::<_, SnippetRow>(
        "SELECT slug, content, language, images, created_at, expires_at \
         FROM snippets WHERE slug = $1 AND expires_at > NOW()"
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

#[derive(Deserialize)]
struct PatchReq {
    content:  Option<String>,
    language: Option<String>,
    images:   Option<Vec<ImageData>>,
}

async fn patch_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
    Json(req): Json<PatchReq>,
) -> Result<impl IntoResponse, AppError> {
    if let Some(c) = req.content {
        sqlx::query(
            "UPDATE snippets SET content = $1 WHERE slug = $2 AND expires_at > NOW()"
        )
        .bind(c)
        .bind(&slug)
        .execute(&s.db)
        .await
        .map_err(AppError::Db)?;
    }
    if let Some(l) = req.language {
        sqlx::query(
            "UPDATE snippets SET language = $1 WHERE slug = $2 AND expires_at > NOW()"
        )
        .bind(l)
        .bind(&slug)
        .execute(&s.db)
        .await
        .map_err(AppError::Db)?;
    }
    if let Some(i) = req.images {
        let j = serde_json::to_string(&i).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "UPDATE snippets SET images = $1 WHERE slug = $2 AND expires_at > NOW()"
        )
        .bind(j)
        .bind(&slug)
        .execute(&s.db)
        .await
        .map_err(AppError::Db)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM snippets WHERE slug = $1")
        .bind(&slug)
        .execute(&s.db)
        .await
        .map_err(AppError::Db)?;
    Ok(StatusCode::NO_CONTENT)
}

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
    let viewers = tx.receiver_count();
    let (mut sender, mut receiver) = socket.split();

    let _ = sender.send(Message::Text(
        serde_json::to_string(&WsMsg::Connected { slug: slug.clone(), viewers }).unwrap().into()
    )).await;

    let _ = tx.send(serde_json::to_string(&WsMsg::Viewers { count: viewers + 1 }).unwrap());

    let slug2  = slug.clone();
    let state2 = state.clone();
    let tx2    = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            let msg: WsMsg = match serde_json::from_str(&text) { Ok(m) => m, Err(_) => continue };
            match msg {
                WsMsg::Edit { ref content, ref language } => {
                    let _ = sqlx::query(
                        "UPDATE snippets SET content = $1, language = $2 \
                         WHERE slug = $3 AND expires_at > NOW()"
                    )
                    .bind(content)
                    .bind(language)
                    .bind(&slug2)
                    .execute(&state2.db)
                    .await;

                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastEdit {
                        content: content.clone(),
                        language: language.clone(),
                    }).unwrap());
                }
                WsMsg::Image { ref image } => {
                    let row: String = sqlx::query_scalar(
                        "SELECT images FROM snippets WHERE slug = $1 AND expires_at > NOW()"
                    )
                    .bind(&slug2)
                    .fetch_optional(&state2.db)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "[]".into());

                    let mut imgs: Vec<ImageData> = serde_json::from_str(&row).unwrap_or_default();
                    if !imgs.iter().any(|i| i.id == image.id) { imgs.push(image.clone()); }
                    let json = serde_json::to_string(&imgs).unwrap();

                    let _ = sqlx::query(
                        "UPDATE snippets SET images = $1 WHERE slug = $2"
                    )
                    .bind(json)
                    .bind(&slug2)
                    .execute(&state2.db)
                    .await;

                    let _ = tx2.send(
                        serde_json::to_string(&WsMsg::BroadcastImage { image: image.clone() }).unwrap()
                    );
                }
                WsMsg::RemoveImage { ref id } => {
                    let row: String = sqlx::query_scalar(
                        "SELECT images FROM snippets WHERE slug = $1 AND expires_at > NOW()"
                    )
                    .bind(&slug2)
                    .fetch_optional(&state2.db)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "[]".into());

                    let mut imgs: Vec<ImageData> = serde_json::from_str(&row).unwrap_or_default();
                    imgs.retain(|i| &i.id != id);
                    let json = serde_json::to_string(&imgs).unwrap();

                    let _ = sqlx::query(
                        "UPDATE snippets SET images = $1 WHERE slug = $2"
                    )
                    .bind(json)
                    .bind(&slug2)
                    .execute(&state2.db)
                    .await;

                    let _ = tx2.send(
                        serde_json::to_string(&WsMsg::BroadcastRemoveImage { id: id.clone() }).unwrap()
                    );
                }
                _ => {}
            }
        }
    });

    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() { break; }
        }
    });

    tokio::select! {
        _ = &mut recv_task => send_task.abort(),
        _ = &mut send_task => recv_task.abort(),
    }

    let remaining = tx.receiver_count().saturating_sub(1);
    let _ = tx.send(serde_json::to_string(&WsMsg::Viewers { count: remaining }).unwrap());
    info!("ws disconnected /{slug}");
}

async fn cleanup(db: PgPool) {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
        match sqlx::query("DELETE FROM snippets WHERE expires_at <= NOW()")
            .execute(&db)
            .await
        {
            Ok(r)  => info!("cleanup: removed {} snippets", r.rows_affected()),
            Err(e) => tracing::error!("cleanup: {e}"),
        }
    }
}

async fn upload_image(
    mut multipart: Multipart,
) -> Result<Json<ImageData>, AppError> {
    let cloud_name    = std::env::var("CLOUDINARY_CLOUD_NAME").unwrap();
    let upload_preset = std::env::var("CLOUDINARY_UPLOAD_PRESET").unwrap();

    while let Some(field) = multipart.next_field().await.unwrap() {
        let data = field.bytes().await.unwrap();

        let form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(data.to_vec()))
            .text("upload_preset", upload_preset);

        let url = format!(
            "https://api.cloudinary.com/v1_1/{}/image/upload",
            cloud_name
        );

        let res = reqwest::Client::new()
            .post(url)
            .multipart(form)
            .send()
            .await
            .unwrap();

        let json: serde_json::Value = res.json().await.unwrap();

        return Ok(Json(ImageData {
            id:     uuid::Uuid::new_v4().to_string(),
            url:    json["secure_url"].as_str().unwrap().to_string(),
            width:  json["width"].as_u64().unwrap() as u32,
            height: json["height"].as_u64().unwrap() as u32,
        }));
    }

    Err(AppError::BadRequest("No file".into()))
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .init();

    let db_url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set");

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .unwrap();

    let frontend = std::env::var("FRONTEND_URL")
        .unwrap_or_else(|_| "http://localhost:5173".into());

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&db_url)
        .await
        .expect("Failed to connect to Postgres");

    db::run_migrations(&db).await;
    info!("db ready");

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
        .route("/health",             get(health))
        .route("/api/upload",         post(upload_image))
        .route("/api/check/:slug",    get(check_slug))
        .route("/api/snippets",       post(create_snippet))
        .route("/api/snippets/:slug", get(get_snippet))
        .route("/api/snippets/:slug", patch(patch_snippet))
        .route("/api/snippets/:slug", delete(delete_snippet))
        .route("/ws/:slug",           get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    info!("listening on http://{addr}");

    axum::serve(
        tokio::net::TcpListener::bind(&addr).await.unwrap(),
        app,
    )
    .await
    .unwrap();
}
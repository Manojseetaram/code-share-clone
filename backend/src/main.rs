use axum::{
    body::Body,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Multipart, Path, State},
    http::{header, HeaderName, Method, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{delete, get, patch, post},
    Router,
};
use bson::{doc, to_bson};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use mongodb::{Collection, Database};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use urlencoding;
use zip::write::FileOptions;

mod db;

type Rooms = Arc<DashMap<String, broadcast::Sender<String>>>;

fn get_or_create_room(rooms: &Rooms, slug: &str) -> broadcast::Sender<String> {
    if let Some(tx) = rooms.get(slug) {
        return tx.clone();
    }
    let (tx, _) = broadcast::channel(128);
    rooms.insert(slug.to_string(), tx.clone());
    tx
}

#[derive(Clone)]
pub struct AppState {
    pub db:    Database,
    pub rooms: Rooms,
}

impl AppState {
    fn col(&self) -> Collection<SnippetRow> {
        self.db.collection::<SnippetRow>("snippets")
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnippetRow {
    pub slug:       String,
    pub content:    String,
    pub language:   String,
    pub images:     Vec<ImageData>,
    pub files:      Vec<FileData>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub slug:     Option<String>,
    pub content:  String,
    pub language: Option<String>,
    pub images:   Option<Vec<ImageData>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageData {
    pub id:     String,
    pub url:    String,
    pub width:  u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileData {
    pub id:   String,   // uuid
    pub name: String,   // original filename
    pub url:  String,   // Cloudinary secure_url (raw resource)
    pub size: u64,      // bytes
    pub mime: String,   // e.g. "application/zip"
}

#[derive(Debug, Serialize)]
pub struct SnippetResponse {
    pub slug:       String,
    pub content:    String,
    pub language:   String,
    pub images:     Vec<ImageData>,
    pub files:      Vec<FileData>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub slug:       String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct SlugCheck {
    pub available: bool,
    pub slug:      String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMsg {
    Edit                 { content: String, language: String },
    Image                { image: ImageData },
    RemoveImage          { id: String },
    File                 { file: FileData },
    RemoveFile           { id: String },
    Connected            { slug: String, viewers: usize },
    Viewers              { count: usize },
    BroadcastEdit        { content: String, language: String },
    BroadcastImage       { image: ImageData },
    BroadcastRemoveImage { id: String },
    BroadcastFile        { file: FileData },
    BroadcastRemoveFile  { id: String },
}

enum AppError {
    NotFound(String),
    BadRequest(String),
    Conflict(String),
    Db(mongodb::error::Error),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            AppError::NotFound(m)   => (StatusCode::NOT_FOUND, m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Conflict(m)   => (StatusCode::CONFLICT, m),
            AppError::Internal(m)   => (StatusCode::INTERNAL_SERVER_ERROR, m),
            AppError::Db(e) => {
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
    if slug.len() < 3  { return Err(AppError::BadRequest("Slug must be >= 3 characters".into())); }
    if slug.len() > 60 { return Err(AppError::BadRequest("Slug must be <= 60 characters".into())); }
    let re = Regex::new(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$").unwrap();
    if !re.is_match(slug) {
        return Err(AppError::BadRequest("Only lowercase letters, numbers, hyphens".into()));
    }
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

fn never() -> DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339("2099-12-31T23:59:59Z")
        .unwrap()
        .with_timezone(&Utc)
}

async fn slug_exists(col: &Collection<SnippetRow>, slug: &str) -> Result<bool, AppError> {
    Ok(col
        .count_documents(doc! { "slug": slug }, None)
        .await
        .map_err(AppError::Db)?
        > 0)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn check_slug(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
) -> impl IntoResponse {
    let slug  = sanitize(&raw);
    let valid = validate(&slug).is_ok();
    let taken = if valid {
        slug_exists(&s.col(), &slug).await.unwrap_or(true)
    } else { true };
    Json(SlugCheck { available: valid && !taken, slug })
}

async fn create_snippet(
    State(s): State<Arc<AppState>>,
    Json(req): Json<CreateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let col = s.col();
    let slug = match req.slug.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let sl = sanitize(raw);
            validate(&sl)?;
            if slug_exists(&col, &sl).await? {
                return Ok((StatusCode::OK, Json(CreateResponse { slug: sl, expires_at: never() })));
            }
            sl
        }
        None => {
            let mut sl = gen_slug();
            for _ in 0..10 {
                if !slug_exists(&col, &sl).await? { break; }
                sl = gen_slug();
            }
            sl
        }
    };

    let row = SnippetRow {
        slug:       slug.clone(),
        content:    req.content,
        language:   req.language.unwrap_or_else(|| "javascript".into()),
        images:     req.images.unwrap_or_default(),
        files:      vec![],
        created_at: Utc::now(),
        expires_at: never(),
    };

    col.insert_one(row, None).await.map_err(AppError::Db)?;
    info!("created /{slug}");
    Ok((StatusCode::CREATED, Json(CreateResponse { slug, expires_at: never() })))
}

async fn get_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let row = s.col()
        .find_one(doc! { "slug": &slug }, None)
        .await
        .map_err(AppError::Db)?
        .ok_or_else(|| AppError::NotFound("Room not found".into()))?;

    Ok(Json(SnippetResponse {
        slug: row.slug, content: row.content, language: row.language,
        images: row.images, files: row.files,
        created_at: row.created_at, expires_at: row.expires_at,
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
    let col    = s.col();
    let filter = doc! { "slug": &slug };
    if let Some(c) = req.content {
        col.update_one(filter.clone(), doc! { "$set": { "content": c } }, None)
            .await.map_err(AppError::Db)?;
    }
    if let Some(l) = req.language {
        col.update_one(filter.clone(), doc! { "$set": { "language": l } }, None)
            .await.map_err(AppError::Db)?;
    }
    if let Some(i) = req.images {
        let b = to_bson(&i).unwrap();
        col.update_one(filter, doc! { "$set": { "images": b } }, None)
            .await.map_err(AppError::Db)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_snippet(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    s.col().delete_one(doc! { "slug": &slug }, None).await.map_err(AppError::Db)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── Upload a file (any type) to Cloudinary as a raw resource ──────────────────
async fn upload_file(mut multipart: Multipart) -> Result<Json<FileData>, AppError> {
    let cloud_name    = std::env::var("CLOUDINARY_CLOUD_NAME").unwrap();
    let upload_preset = std::env::var("CLOUDINARY_UPLOAD_PRESET").unwrap();

    while let Some(field) = multipart.next_field().await.unwrap() {
        let original_name = field
            .file_name()
            .unwrap_or("file")
            .to_string();
        let mime_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();

        let data = field.bytes().await.unwrap();
        let size = data.len() as u64;

        let form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(data.to_vec())
                .file_name(original_name.clone()))
            .text("upload_preset", upload_preset)
            .text("resource_type", "raw");

        let url = format!(
            "https://api.cloudinary.com/v1_1/{}/raw/upload",
            cloud_name
        );
        let res  = reqwest::Client::new().post(url).multipart(form).send().await.unwrap();
        let json: serde_json::Value = res.json().await.unwrap();

        return Ok(Json(FileData {
            id:   uuid::Uuid::new_v4().to_string(),
            name: original_name,
            url:  json["secure_url"].as_str().unwrap().to_string(),
            size,
            mime: mime_type,
        }));
    }
    Err(AppError::BadRequest("No file provided".into()))
}

// ── Download all files in a room as a ZIP ─────────────────────────────────────
async fn download_zip(
    State(s): State<Arc<AppState>>,
    Path(slug): Path<String>,
) -> Result<Response, AppError> {
    let row = s.col()
        .find_one(doc! { "slug": &slug }, None)
        .await
        .map_err(AppError::Db)?
        .ok_or_else(|| AppError::NotFound("Room not found".into()))?;

    if row.files.is_empty() {
        return Err(AppError::BadRequest("No files to download".into()));
    }

    let buf    = Vec::new();
    let cursor = std::io::Cursor::new(buf);
    let mut zip = zip::ZipWriter::new(cursor);
    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let http = reqwest::Client::new();

    for file in &row.files {
        let bytes = http
            .get(&file.url)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("fetch failed: {e}")))?
            .bytes()
            .await
            .map_err(|e| AppError::Internal(format!("read failed: {e}")))?;

        zip.start_file(&file.name, options)
            .map_err(|e| AppError::Internal(format!("zip error: {e}")))?;

        use std::io::Write;
        zip.write_all(&bytes)
            .map_err(|e| AppError::Internal(format!("zip write: {e}")))?;
    }

    let cursor   = zip.finish()
        .map_err(|e| AppError::Internal(format!("zip finish: {e}")))?;
    let zip_bytes = cursor.into_inner();

    let zip_name = format!("{slug}.zip");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{zip_name}\""),
        )
        .body(Body::from(zip_bytes))
        .unwrap())
}

// ── Proxy: stream a single file from Cloudinary with correct headers ──────────
// This avoids CORS issues and ensures the browser receives Content-Disposition.
async fn proxy_file(
    State(s): State<Arc<AppState>>,
    Path((slug, file_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    // Look up the file metadata in MongoDB
    let row = s.col()
        .find_one(doc! { "slug": &slug }, None)
        .await
        .map_err(AppError::Db)?
        .ok_or_else(|| AppError::NotFound("Room not found".into()))?;

    let file = row
        .files
        .into_iter()
        .find(|f| f.id == file_id)
        .ok_or_else(|| AppError::NotFound("File not found".into()))?;

    // Fetch the actual bytes from Cloudinary server-side
    let bytes = reqwest::Client::new()
        .get(&file.url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("fetch failed: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("read body failed: {e}")))?;

    // Encode filename for Content-Disposition (handles spaces, unicode, etc.)
    let encoded_name = urlencoding::encode(&file.name);
    let disposition  = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        file.name.replace('"', "\\\""),
        encoded_name,
    );

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE,        file.mime)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH,      bytes.len().to_string())
        // Allow the Vercel frontend to read this response
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Image upload ──────────────────────────────────────────────────────────────
async fn upload_image(mut multipart: Multipart) -> Result<Json<ImageData>, AppError> {
    let cloud_name    = std::env::var("CLOUDINARY_CLOUD_NAME").unwrap();
    let upload_preset = std::env::var("CLOUDINARY_UPLOAD_PRESET").unwrap();

    while let Some(field) = multipart.next_field().await.unwrap() {
        let data = field.bytes().await.unwrap();
        let form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(data.to_vec()))
            .text("upload_preset", upload_preset);
        let url  = format!("https://api.cloudinary.com/v1_1/{}/image/upload", cloud_name);
        let res  = reqwest::Client::new().post(url).multipart(form).send().await.unwrap();
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

// ── WebSocket ─────────────────────────────────────────────────────────────────
async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(slug): Path<String>,
    State(s): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, slug, s))
}

async fn handle_ws(socket: WebSocket, slug: String, state: Arc<AppState>) {
    let tx      = get_or_create_room(&state.rooms, &slug);
    let mut rx  = tx.subscribe();
    let viewers = tx.receiver_count();
    let (mut sender, mut receiver) = socket.split();

    let _ = sender.send(Message::Text(
        serde_json::to_string(&WsMsg::Connected { slug: slug.clone(), viewers }).unwrap().into(),
    )).await;
    let _ = tx.send(serde_json::to_string(&WsMsg::Viewers { count: viewers + 1 }).unwrap());

    let slug2  = slug.clone();
    let state2 = state.clone();
    let tx2    = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        let col = state2.col();
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            let msg: WsMsg = match serde_json::from_str(&text) { Ok(m) => m, Err(_) => continue };
            match msg {
                WsMsg::Edit { ref content, ref language } => {
                    let _ = col.update_one(
                        doc! { "slug": &slug2 },
                        doc! { "$set": { "content": content, "language": language } },
                        None,
                    ).await;
                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastEdit {
                        content: content.clone(), language: language.clone(),
                    }).unwrap());
                }
                WsMsg::Image { ref image } => {
                    let row = col.find_one(doc! { "slug": &slug2 }, None).await.ok().flatten();
                    let mut imgs: Vec<ImageData> = row.map(|r| r.images).unwrap_or_default();
                    if !imgs.iter().any(|i| i.id == image.id) { imgs.push(image.clone()); }
                    let _ = col.update_one(
                        doc! { "slug": &slug2 },
                        doc! { "$set": { "images": to_bson(&imgs).unwrap() } },
                        None,
                    ).await;
                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastImage { image: image.clone() }).unwrap());
                }
                WsMsg::RemoveImage { ref id } => {
                    let row = col.find_one(doc! { "slug": &slug2 }, None).await.ok().flatten();
                    let mut imgs: Vec<ImageData> = row.map(|r| r.images).unwrap_or_default();
                    imgs.retain(|i| &i.id != id);
                    let _ = col.update_one(
                        doc! { "slug": &slug2 },
                        doc! { "$set": { "images": to_bson(&imgs).unwrap() } },
                        None,
                    ).await;
                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastRemoveImage { id: id.clone() }).unwrap());
                }
                WsMsg::File { ref file } => {
                    let row = col.find_one(doc! { "slug": &slug2 }, None).await.ok().flatten();
                    let mut files: Vec<FileData> = row.map(|r| r.files).unwrap_or_default();
                    if !files.iter().any(|f| f.id == file.id) { files.push(file.clone()); }
                    let _ = col.update_one(
                        doc! { "slug": &slug2 },
                        doc! { "$set": { "files": to_bson(&files).unwrap() } },
                        None,
                    ).await;
                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastFile { file: file.clone() }).unwrap());
                }
                WsMsg::RemoveFile { ref id } => {
                    let row = col.find_one(doc! { "slug": &slug2 }, None).await.ok().flatten();
                    let mut files: Vec<FileData> = row.map(|r| r.files).unwrap_or_default();
                    files.retain(|f| &f.id != id);
                    let _ = col.update_one(
                        doc! { "slug": &slug2 },
                        doc! { "$set": { "files": to_bson(&files).unwrap() } },
                        None,
                    ).await;
                    let _ = tx2.send(serde_json::to_string(&WsMsg::BroadcastRemoveFile { id: id.clone() }).unwrap());
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

// ── main ──────────────────────────────────────────────────────────────────────
#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3004".into())
        .parse()
        .unwrap();

    let frontend = std::env::var("FRONTEND_URL")
        .unwrap_or_else(|_| "http://localhost:5173".into());

    let db = db::get_database().await;
    info!("db ready");

    let state = Arc::new(AppState { db, rooms: Arc::new(DashMap::new()) });

    // ── CORS: explicit methods + headers so Render's proxy doesn't strip them ──
    let cors = CorsLayer::new()
        .allow_origin(
            frontend
                .parse::<axum::http::HeaderValue>()
                .expect("Invalid FRONTEND_URL"),
        )
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
            HeaderName::from_static("x-requested-with"),
        ]);

    // ── Router: chain methods on the same path — do NOT use separate .route() ──
    //    calls for the same path because each one silently replaces the previous.
    let app = Router::new()
        .route("/health",                          get(health))
        .route("/api/upload",                      post(upload_image))
        .route("/api/upload-file",                 post(upload_file))
        .route("/api/check/:slug",                 get(check_slug))
        .route("/api/snippets",                    post(create_snippet))
        // ↓ FIXED: get/patch/delete chained on the same path
        .route(
            "/api/snippets/:slug",
            get(get_snippet).patch(patch_snippet).delete(delete_snippet),
        )
        .route("/api/snippets/:slug/download-zip",          get(download_zip))
        .route("/api/snippets/:slug/files/:file_id",        get(proxy_file))
        .route("/ws/:slug",                        get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    info!("listening on http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}
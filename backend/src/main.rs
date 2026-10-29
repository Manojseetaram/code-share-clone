use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Json, Redirect, Response},
    routing::{get, post},
    Router,
};
use bson::{doc, to_bson};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use mongodb::{Collection, Database};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;
use zip::write::FileOptions;

mod db;

// ── Rooms ─────────────────────────────────────────────────────────────────────
// Each broadcast item is (sender_connection_id, json). Empty sender id = "for everyone".
struct Room {
    tx: broadcast::Sender<(String, String)>,
    viewers: AtomicUsize,
}

type Rooms = Arc<DashMap<String, Arc<Room>>>;

const MAX_UPLOAD_BYTES: u64 = 5 * 1024 * 1024 * 1024; // S3 single PUT limit: 5 GB
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25 MB for images via the server
const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024; // 2 MB of code per room

fn get_or_create_room(rooms: &Rooms, slug: &str) -> Arc<Room> {
    let room = rooms
        .entry(slug.to_string())
        .or_insert_with(|| {
            let (tx, _) = broadcast::channel(128);
            Arc::new(Room { tx, viewers: AtomicUsize::new(0) })
        })
        .clone();
    room
}

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub rooms: Rooms,
    pub s3: Client,
}

impl AppState {
    fn col(&self) -> Collection<SnippetRow> {
        self.db.collection::<SnippetRow>("snippets")
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SnippetRow {
    pub slug: String,
    pub content: String,
    pub language: String,
    #[serde(default)]
    pub images: Vec<ImageData>,
    #[serde(default)]
    pub files: Vec<FileData>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub slug: Option<String>,
    pub content: String,
    pub language: Option<String>,
    pub images: Option<Vec<ImageData>>,
    pub files: Option<Vec<FileData>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageData {
    pub id: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileData {
    pub id: String,   // uuid
    pub name: String, // original filename
    pub url: String,  // S3 object URL
    pub size: u64,    // bytes
    pub mime: String, // e.g. "video/mp4"
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SnippetResponse {
    pub slug: String,
    pub content: String,
    pub language: String,
    pub images: Vec<ImageData>,
    pub files: Vec<FileData>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMsg {
    Edit { content: String, language: String },
    Image { image: ImageData },
    RemoveImage { id: String },
    File { file: FileData },
    RemoveFile { id: String },
    Connected { slug: String, viewers: usize },
    Viewers { count: usize },
    BroadcastEdit { content: String, language: String },
    BroadcastImage { image: ImageData },
    BroadcastRemoveImage { id: String },
    BroadcastFile { file: FileData },
    BroadcastRemoveFile { id: String },
}

enum AppError {
    NotFound(String),
    BadRequest(String),
    Db(mongodb::error::Error),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Internal(m) => {
                tracing::error!("internal: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, m)
            }
            AppError::Db(e) => {
                tracing::error!("db: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "database error".into())
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

// ── Slug helpers (frontend `normalizeSlug` mirrors this exactly) ──────────────
fn sanitize(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn slug_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$").unwrap())
}

fn validate(slug: &str) -> Result<(), AppError> {
    if slug.len() < 3 {
        return Err(AppError::BadRequest("Slug must be >= 3 characters".into()));
    }
    if slug.len() > 60 {
        return Err(AppError::BadRequest("Slug must be <= 60 characters".into()));
    }
    if !slug_regex().is_match(slug) {
        return Err(AppError::BadRequest("Only letters, numbers, hyphens".into()));
    }
    for r in &["api", "admin", "health", "ws", "new", "static", "assets"] {
        if *r == slug {
            return Err(AppError::BadRequest(format!("'{slug}' is reserved")));
        }
    }
    Ok(())
}

fn gen_slug() -> String {
    const ALPHABET: &[char] = &[
        'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
        's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
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

async fn find_row(s: &AppState, slug: &str) -> Result<SnippetRow, AppError> {
    s.col()
        .find_one(doc! { "slug": slug }, None)
        .await
        .map_err(AppError::Db)?
        .ok_or_else(|| AppError::NotFound("Room not found".into()))
}

// ── S3 helpers ────────────────────────────────────────────────────────────────
fn s3_bucket_name() -> String {
    std::env::var("S3_BUCKET").unwrap_or_else(|_| "codeshare-devs".into())
}

fn s3_region() -> String {
    std::env::var("AWS_REGION").unwrap_or_else(|_| "ap-south-1".into())
}

fn s3_file_url(key: &str) -> String {
    let bucket = s3_bucket_name();
    if s3_region() == "us-east-1" {
        format!("https://{bucket}.s3.amazonaws.com/{key}")
    } else {
        format!("https://{bucket}.s3.{}.amazonaws.com/{key}", s3_region())
    }
}

/// Keep object keys boring: only ASCII letters, digits, dot, dash, underscore.
fn safe_file_name(raw: &str, fallback: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
}

// Objects are private; they are only reachable through this server
// (image proxy / presigned GET), so no public ACL is needed.
async fn put_s3(s3: &Client, key: &str, data: Vec<u8>, content_type: &str) -> Result<String, AppError> {
    s3.put_object()
        .bucket(s3_bucket_name())
        .key(key)
        .body(data.into())
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("S3 upload failed: {e}")))?;
    Ok(s3_file_url(key))
}

fn s3_key_from_url(url: &str) -> Result<String, AppError> {
    let marker = "amazonaws.com/";
    let pos = url
        .find(marker)
        .ok_or_else(|| AppError::BadRequest(format!("invalid S3 URL: {url}")))?;
    Ok(url[pos + marker.len()..].to_string())
}

async fn get_s3_object(s3: &Client, url: &str) -> Result<(Vec<u8>, Option<String>), AppError> {
    let key = s3_key_from_url(url)?;
    let output = s3
        .get_object()
        .bucket(s3_bucket_name())
        .key(&key)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("S3 get_object failed for key {key}: {e}")))?;
    let content_type = output.content_type().map(|s| s.to_string());
    let mut bytes = Vec::new();
    let mut stream = output.body;
    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| AppError::Internal(format!("S3 read error: {e}")))?;
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, content_type))
}

fn content_disposition(name: &str, inline: bool) -> String {
    let kind = if inline { "inline" } else { "attachment" };
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii() && !c.is_control() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    format!(
        "{kind}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        urlencoding::encode(name),
    )
}

// ── Handlers ──────────────────────────────────────────────────────────────────
async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true }))
}

async fn check_slug(State(s): State<Arc<AppState>>, Path(raw): Path<String>) -> impl IntoResponse {
    let slug = sanitize(&raw);
    let valid = validate(&slug).is_ok();
    let taken = if valid {
        slug_exists(&s.col(), &slug).await.unwrap_or(true)
    } else {
        true
    };
    Json(SlugCheck { available: valid && !taken, slug })
}

async fn create_snippet(
    State(s): State<Arc<AppState>>,
    Json(req): Json<CreateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let col = s.col();

    if req.content.len() > MAX_CONTENT_BYTES {
        return Err(AppError::BadRequest("Content too large".into()));
    }

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
                if !slug_exists(&col, &sl).await? {
                    break;
                }
                sl = gen_slug();
            }
            sl
        }
    };

    let row = SnippetRow {
        slug: slug.clone(),
        content: req.content,
        language: req.language.unwrap_or_else(|| "javascript".into()),
        images: req.images.unwrap_or_default(),
        files: req.files.unwrap_or_default(),
        created_at: Utc::now(),
        expires_at: never(),
    };

    match col.insert_one(row, None).await {
        Ok(_) => {
            info!("created /{slug}");
            Ok((StatusCode::CREATED, Json(CreateResponse { slug, expires_at: never() })))
        }
        // Two clients created the same room at the same moment — that's fine.
        Err(e) if e.to_string().contains("E11000") => {
            Ok((StatusCode::OK, Json(CreateResponse { slug, expires_at: never() })))
        }
        Err(e) => Err(AppError::Db(e)),
    }
}

async fn get_snippet(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let slug = sanitize(&raw);
    let row = find_row(&s, &slug).await?;

    Ok(Json(SnippetResponse {
        slug: row.slug,
        content: row.content,
        language: row.language,
        images: row.images,
        files: row.files,
        created_at: row.created_at,
        expires_at: row.expires_at,
    }))
}

#[derive(Deserialize)]
struct PatchReq {
    content: Option<String>,
    language: Option<String>,
}

// Fallback used by the frontend when the WebSocket is temporarily down.
async fn patch_snippet(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
    Json(req): Json<PatchReq>,
) -> Result<impl IntoResponse, AppError> {
    let slug = sanitize(&raw);
    let mut set = doc! {};
    if let Some(c) = req.content {
        if c.len() > MAX_CONTENT_BYTES {
            return Err(AppError::BadRequest("Content too large".into()));
        }
        set.insert("content", c);
    }
    if let Some(l) = req.language {
        set.insert("language", l);
    }
    if set.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let res = s
        .col()
        .update_one(doc! { "slug": &slug }, doc! { "$set": set }, None)
        .await
        .map_err(AppError::Db)?;
    if res.matched_count == 0 {
        return Err(AppError::NotFound("Room not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ── Presigned upload: browser PUTs the file straight to S3 ────────────────────
#[derive(Deserialize)]
struct PresignReq {
    name: String,
    mime: String,
    size: u64,
}

#[derive(Serialize)]
struct PresignResp {
    upload_url: String,
    file: FileData,
}

async fn presign_upload(
    State(s): State<Arc<AppState>>,
    Json(req): Json<PresignReq>,
) -> Result<Json<PresignResp>, AppError> {
    if req.size == 0 {
        return Err(AppError::BadRequest("Empty file".into()));
    }
    if req.size > MAX_UPLOAD_BYTES {
        return Err(AppError::BadRequest("File too large (max 5 GB)".into()));
    }

    let uid = uuid::Uuid::new_v4().to_string();
    let key = format!("files/{uid}/{}", safe_file_name(&req.name, "file"));

    let cfg = PresigningConfig::expires_in(Duration::from_secs(6 * 3600))
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let presigned = s
        .s3
        .put_object()
        .bucket(s3_bucket_name())
        .key(&key)
        .content_type(&req.mime) // signed: browser must send the same Content-Type
        .presigned(cfg)
        .await
        .map_err(|e| AppError::Internal(format!("presign failed: {e}")))?;

    Ok(Json(PresignResp {
        upload_url: presigned.uri().to_string(),
        file: FileData {
            id: uuid::Uuid::new_v4().to_string(),
            name: req.name,
            url: s3_file_url(&key),
            size: req.size,
            mime: req.mime,
            folder: None,
        },
    }))
}

// ── Download all files in a room as a ZIP ─────────────────────────────────────
// NOTE: buffers every file in memory. Fine for small rooms; for rooms with large
// videos, download files individually.
async fn download_zip(
    State(s): State<Arc<AppState>>,
    Path(raw): Path<String>,
) -> Result<Response, AppError> {
    let slug = sanitize(&raw);
    let row = find_row(&s, &slug).await?;

    if row.files.is_empty() {
        return Err(AppError::BadRequest("No files to download".into()));
    }

    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut used: HashSet<String> = HashSet::new();

    for file in &row.files {
        let (bytes, _ct) = get_s3_object(&s.s3, &file.url).await?;

        // avoid duplicate names inside the archive
        let base = safe_file_name(&file.name, "file");
        let mut name = base.clone();
        let mut n = 1;
        while !used.insert(name.clone()) {
            name = format!("{n}_{base}");
            n += 1;
        }

        zip.start_file(name, options)
            .map_err(|e| AppError::Internal(format!("zip error: {e}")))?;

        use std::io::Write;
        zip.write_all(&bytes)
            .map_err(|e| AppError::Internal(format!("zip write: {e}")))?;
    }

    let cursor = zip
        .finish()
        .map_err(|e| AppError::Internal(format!("zip finish: {e}")))?;
    let zip_bytes = cursor.into_inner();

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_DISPOSITION, content_disposition(&format!("{slug}.zip"), false))
        .body(Body::from(zip_bytes))
        .unwrap())
}

// ── Serve a file: small text is proxied, everything else redirects to S3 ──────
// ?dl=1 forces a download (Content-Disposition: attachment).
async fn proxy_file(
    State(s): State<Arc<AppState>>,
    Path((raw, file_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let slug = sanitize(&raw);
    let row = find_row(&s, &slug).await?;

    let file = row
        .files
        .into_iter()
        .find(|f| f.id == file_id)
        .ok_or_else(|| AppError::NotFound("File not found".into()))?;

    let force_download = q.get("dl").map(|v| v == "1").unwrap_or(false);

    let inline_type = file.mime.starts_with("image/")
        || file.mime.starts_with("video/")
        || file.mime.starts_with("audio/")
        || file.mime == "application/pdf"
        || file.mime.starts_with("text/");
    let inline = inline_type && !force_download;

    // Text files are read by the in-app viewer with fetch(); proxy them so no
    // S3 CORS / redirect-origin issues arise. They are small, so buffering is fine.
    if file.mime.starts_with("text/") && !force_download {
        let (bytes, _ct) = get_s3_object(&s.s3, &file.url).await?;
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, file.mime.clone())
            .header(header::CONTENT_DISPOSITION, content_disposition(&file.name, true))
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(Body::from(bytes))
            .unwrap());
    }

    // Everything else: redirect to a short-lived presigned S3 URL.
    // S3 supports Range requests, so video seeking works and the server holds nothing.
    let key = s3_key_from_url(&file.url)?;
    let cfg = PresigningConfig::expires_in(Duration::from_secs(3600))
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let presigned = s
        .s3
        .get_object()
        .bucket(s3_bucket_name())
        .key(key)
        .response_content_type(&file.mime)
        .response_content_disposition(content_disposition(&file.name, inline))
        .presigned(cfg)
        .await
        .map_err(|e| AppError::Internal(format!("presign get failed: {e}")))?;

    Ok(Redirect::temporary(presigned.uri()).into_response())
}

// ── Proxy an image (served via S3 GetObject with backend credentials) ─────────
async fn proxy_image(
    State(s): State<Arc<AppState>>,
    Path((raw, image_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let slug = sanitize(&raw);
    let row = find_row(&s, &slug).await?;

    let image = row
        .images
        .into_iter()
        .find(|i| i.id == image_id)
        .ok_or_else(|| AppError::NotFound("Image not found".into()))?;

    let (bytes, content_type) = get_s3_object(&s.s3, &image.url).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type.unwrap_or_else(|| "image/jpeg".to_string()))
        .header(header::CONTENT_DISPOSITION, content_disposition(&image.id, true))
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Image upload (small, goes through the server) ─────────────────────────────
async fn upload_image(
    State(s): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<ImageData>, AppError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("upload error: {e}")))?
        .ok_or_else(|| AppError::BadRequest("No file".into()))?;

    let mime_type = field.content_type().unwrap_or("image/jpeg").to_string();
    if !mime_type.starts_with("image/") {
        return Err(AppError::BadRequest("Only image files are allowed here".into()));
    }
    let safe_name = safe_file_name(field.file_name().unwrap_or("image"), "image");
    let data = field
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("read error: {e}")))?;

    let uid = uuid::Uuid::new_v4().to_string();
    let key = format!("images/{uid}/{safe_name}");

    let url = put_s3(&s.s3, &key, data.to_vec(), &mime_type).await?;

    Ok(Json(ImageData {
        id: uuid::Uuid::new_v4().to_string(),
        url,
        width: 0,
        height: 0,
    }))
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(raw): Path<String>,
    State(s): State<Arc<AppState>>,
) -> impl IntoResponse {
    let slug = sanitize(&raw);
    ws.on_upgrade(move |socket| handle_ws(socket, slug, s))
}

async fn handle_ws(socket: WebSocket, slug: String, state: Arc<AppState>) {
    let room = get_or_create_room(&state.rooms, &slug);
    let conn_id = uuid::Uuid::new_v4().to_string();
    let mut rx = room.tx.subscribe();
    let viewers = room.viewers.fetch_add(1, Ordering::SeqCst) + 1;
    let (mut sender, mut receiver) = socket.split();

    let _ = sender
        .send(Message::Text(
            serde_json::to_string(&WsMsg::Connected { slug: slug.clone(), viewers })
                .unwrap()
                .into(),
        ))
        .await;
    let _ = room.tx.send((
        String::new(),
        serde_json::to_string(&WsMsg::Viewers { count: viewers }).unwrap(),
    ));

    let slug2 = slug.clone();
    let state2 = state.clone();
    let tx2 = room.tx.clone();
    let conn2 = conn_id.clone();

    let mut recv_task = tokio::spawn(async move {
        let col = state2.col();
        let filter = doc! { "slug": &slug2 };

        loop {
            let text = match receiver.next().await {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => continue, // ping / pong / binary
            };

            let msg: WsMsg = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };

            let out: Option<WsMsg> = match msg {
                WsMsg::Edit { content, language } => {
                    if content.len() > MAX_CONTENT_BYTES {
                        None
                    } else {
                        let _ = col
                            .update_one(
                                filter.clone(),
                                doc! { "$set": { "content": &content, "language": &language } },
                                None,
                            )
                            .await;
                        Some(WsMsg::BroadcastEdit { content, language })
                    }
                }
                WsMsg::Image { image } => {
                    if let Ok(b) = to_bson(&image) {
                        // atomic, and skipped if this id already exists
                        let _ = col
                            .update_one(
                                doc! { "slug": &slug2, "images.id": { "$ne": &image.id } },
                                doc! { "$push": { "images": b } },
                                None,
                            )
                            .await;
                    }
                    Some(WsMsg::BroadcastImage { image })
                }
                WsMsg::RemoveImage { id } => {
                    let _ = col
                        .update_one(
                            filter.clone(),
                            doc! { "$pull": { "images": { "id": &id } } },
                            None,
                        )
                        .await;
                    Some(WsMsg::BroadcastRemoveImage { id })
                }
                WsMsg::File { file } => {
                    if let Ok(b) = to_bson(&file) {
                        let _ = col
                            .update_one(
                                doc! { "slug": &slug2, "files.id": { "$ne": &file.id } },
                                doc! { "$push": { "files": b } },
                                None,
                            )
                            .await;
                    }
                    Some(WsMsg::BroadcastFile { file })
                }
                WsMsg::RemoveFile { id } => {
                    let _ = col
                        .update_one(
                            filter.clone(),
                            doc! { "$pull": { "files": { "id": &id } } },
                            None,
                        )
                        .await;
                    Some(WsMsg::BroadcastRemoveFile { id })
                }
                _ => None,
            };

            if let Some(m) = out {
                // tagged with our connection id so we don't echo it back to ourselves
                let _ = tx2.send((conn2.clone(), serde_json::to_string(&m).unwrap()));
            }
        }
    });

    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok((from, msg)) => {
                    if from == conn_id {
                        continue;
                    }
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    tokio::select! {
        _ = &mut recv_task => send_task.abort(),
        _ = &mut send_task => recv_task.abort(),
    }

    let remaining = room.viewers.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
    let _ = room.tx.send((
        String::new(),
        serde_json::to_string(&WsMsg::Viewers { count: remaining }).unwrap(),
    ));
    if remaining == 0 {
        // free the room's channel once the last viewer leaves
        state
            .rooms
            .remove_if(&slug, |_, r| r.viewers.load(Ordering::SeqCst) == 0);
    }
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
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .expect("PORT must be a number");

    // Comma-separated list is allowed: "https://app.com,https://www.app.com"
    let frontend =
        std::env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:5173".into());
    let origins: Vec<HeaderValue> = frontend
        .split(',')
        .map(|o| o.trim().trim_end_matches('/'))
        .filter(|o| !o.is_empty())
        .map(|o| o.parse::<HeaderValue>().expect("Invalid FRONTEND_URL"))
        .collect();

    let db = db::get_database().await;
    info!("db ready");

    let aws_cfg = aws_config::load_from_env().await;
    let s3 = Client::new(&aws_cfg);

    let state = Arc::new(AppState { db, rooms: Arc::new(DashMap::new()), s3 });

    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::OPTIONS])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
            HeaderName::from_static("x-requested-with"),
        ]);

    let app = Router::new()
        .route("/health", get(health))
        // images go through the server, capped at 25 MB
        .route(
            "/api/upload",
            post(upload_image).layer(DefaultBodyLimit::max(MAX_IMAGE_BYTES)),
        )
        // files/videos upload straight to S3 via a presigned URL
        .route("/api/presign-upload", post(presign_upload))
        .route("/api/check/:slug", get(check_slug))
        .route("/api/snippets", post(create_snippet))
        .route("/api/snippets/:slug", get(get_snippet).patch(patch_snippet))
        .route("/api/snippets/:slug/download-zip", get(download_zip))
        .route("/api/snippets/:slug/files/:file_id", get(proxy_file))
        .route("/api/snippets/:slug/images/:image_id", get(proxy_image))
        .route("/ws/:slug", get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    info!("listening on http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app)
        .await
        .unwrap();
}
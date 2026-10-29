use aws_sdk_s3::Client;
use aws_sdk_s3::types::ObjectCannedAcl;
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
    pub s3:    Client,
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
    pub files:    Option<Vec<FileData>>,
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
    pub url:  String,   // S3 object URL (public)
    pub size: u64,      // bytes
    pub mime: String,   // e.g. "application/zip"
    #[serde(default)]
    pub folder: Option<String>,
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

async fn put_s3(s3: &Client, key: &str, data: &[u8], content_type: &str) -> Result<String, AppError> {
    let bucket = s3_bucket_name();
    let result = s3
        .put_object()
        .bucket(&bucket)
        .key(key)
        .body(data.to_vec().into())
        .content_type(content_type)
        .acl(ObjectCannedAcl::PublicRead)
        .send()
        .await;
    match result {
        Ok(_) => Ok(s3_file_url(key)),
        Err(_) => {
            // Bucket policy may govern public access instead of ACLs — retry without ACL.
            let result = s3
                .put_object()
                .bucket(&bucket)
                .key(key)
                .body(data.to_vec().into())
                .content_type(content_type)
                .send()
                .await;
            match result {
                Ok(_) => Ok(s3_file_url(key)),
                Err(e) => {
                    tracing::error!("S3 put_object failed for key {key}: {e}");
                    Err(AppError::Internal(format!("S3 upload failed: {e}")))
                }
            }
        }
    }
}

fn s3_key_from_url(url: &str) -> Result<String, AppError> {
    let marker = "amazonaws.com/";
    let pos = url.find(marker).ok_or_else(|| AppError::BadRequest(format!("invalid S3 URL: {url}")))?;
    Ok(url[pos + marker.len()..].to_string())
}

async fn get_s3_object(
    s3: &Client,
    url: &str,
) -> Result<(Vec<u8>, Option<String>), AppError> {
    let bucket = s3_bucket_name();
    let key = s3_key_from_url(url)?;
    let mut output = s3
        .get_object()
        .bucket(&bucket)
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
        files:      req.files.unwrap_or_default(),
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
    files:    Option<Vec<FileData>>,
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
        col.update_one(filter.clone(), doc! { "$set": { "images": b } }, None)
            .await.map_err(AppError::Db)?;
    }
    if let Some(f) = req.files {
        let b = to_bson(&f).unwrap();
        col.update_one(filter, doc! { "$set": { "files": b } }, None)
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

// ── Upload a file (any type) to S3 ────────────────────────────────────────────
async fn upload_file(
    State(s): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<FileData>, AppError> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("upload error: {e}")))?
        .ok_or_else(|| AppError::BadRequest("No file provided".into()))?;

    let original_name = field.file_name().unwrap_or("file").to_string();
    let mime_type = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();
    let data = field.bytes().await.map_err(|e| AppError::BadRequest(format!("read error: {e}")))?.to_vec();
    let size = data.len() as u64;

    let uid = uuid::Uuid::new_v4().to_string();
    let safe_name = original_name.rsplit('/').next().unwrap_or("file").to_string();
    let key = format!("files/{uid}/{}", safe_name.replace(' ', "_"));

    let url = put_s3(&s.s3, &key, &data, &mime_type).await?;

    Ok(Json(FileData {
        id:     uuid::Uuid::new_v4().to_string(),
        name:   original_name,
        url,
        size,
        mime: mime_type,
        folder: None,
    }))
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

    for file in &row.files {
        let (bytes, _content_type) = get_s3_object(&s.s3, &file.url).await?;

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

    // Fetch the actual bytes from S3 using backend credentials (private-bucket safe)
    let (bytes, _content_type) = get_s3_object(&s.s3, &file.url).await?;

    // Encode filename for Content-Disposition (handles spaces, unicode, etc.)
    let encoded_name = urlencoding::encode(&file.name);
    let inline = file.mime.starts_with("image/")
        || file.mime.starts_with("video/")
        || file.mime.starts_with("audio/")
        || file.mime == "application/pdf"
        || file.mime.starts_with("text/");
    let disposition = if inline {
        format!(
            "inline; filename=\"{}\"; filename*=UTF-8''{}",
            file.name.replace('"', "\\\""),
            encoded_name,
        )
    } else {
        format!(
            "attachment; filename=\"{}\"; filename*=UTF-8''{}",
            file.name.replace('"', "\\\""),
            encoded_name,
        )
    };
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

// ── Proxy an image (served via S3 GetObject with backend credentials) ─────────
async fn proxy_image(
    State(s): State<Arc<AppState>>,
    Path((slug, image_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let row = s.col()
        .find_one(doc! { "slug": &slug }, None)
        .await
        .map_err(AppError::Db)?
        .ok_or_else(|| AppError::NotFound("Room not found".into()))?;

    let image = row
        .images
        .into_iter()
        .find(|i| i.id == image_id)
        .ok_or_else(|| AppError::NotFound("Image not found".into()))?;

    let (bytes, content_type) = get_s3_object(&s.s3, &image.url).await?;

    let encoded_name = urlencoding::encode(&image.id);
    let disposition = format!(
        "inline; filename=\"{image_id}\"; filename*=UTF-8''{encoded_name}",
        image_id = image_id,
        encoded_name = encoded_name,
    );

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type.unwrap_or_else(|| "image/jpeg".to_string()))
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Image upload ──────────────────────────────────────────────────────────────
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
    let safe_name = field.file_name().unwrap_or("image").to_string();
    let data = field.bytes().await.map_err(|e| AppError::BadRequest(format!("read error: {e}")))?.to_vec();

    let uid = uuid::Uuid::new_v4().to_string();
    let key = format!("images/{uid}/{}", safe_name.replace(' ', "_"));

    let url = put_s3(&s.s3, &key, &data, &mime_type).await?;

    Ok(Json(ImageData {
        id:     uuid::Uuid::new_v4().to_string(),
        url,
        width:  0,
        height: 0,
    }))
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
        .unwrap_or_else(|_| "3001".into())
        .parse()
        .unwrap();

    let frontend = std::env::var("FRONTEND_URL")
        .unwrap_or_else(|_| "http://localhost:5173".into());

    let db = db::get_database().await;
    info!("db ready");

    let aws_cfg = aws_config::load_from_env().await;
    let s3 = Client::new(&aws_cfg);

    let state = Arc::new(AppState { db, rooms: Arc::new(DashMap::new()), s3 });


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
        .route("/api/snippets/:slug/images/:image_id",      get(proxy_image))
        .route("/ws/:slug",                        get(ws_handler))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    info!("listening on http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}
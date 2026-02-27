// use axum::{
//     http::StatusCode,
//     response::{IntoResponse, Json},
// };
// use serde_json::json;

// #[derive(Debug)]

// pub enum AppError {
//     NotFound(String),
//     BadRequest(String),
//     Conflict(String),
//     Db(sqlx::Error),
//     Internal(String),
// }

// impl IntoResponse for AppError {
//     fn into_response(self) -> axum::response::Response {
//         let (status, message) = match self {
//             AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
//             AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
//             AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
//             AppError::Db(e) => {
//                 tracing::error!("Database error: {}", e);
//                 (StatusCode::INTERNAL_SERVER_ERROR, "Database error".to_string())
//             }
//             AppError::Internal(msg) => {
//                 tracing::error!("Internal error: {}", msg);
//                 (StatusCode::INTERNAL_SERVER_ERROR, msg)
//             }
//         };

//         (status, Json(json!({ "error": message }))).into_response()
//     }
// }
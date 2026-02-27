# Build stage
FROM rust:1.76-slim as builder
WORKDIR /app
RUN apt-get update && apt-get install -y libsqlite3-dev pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y libsqlite3-0 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data
WORKDIR /app
COPY --from=builder /app/target/release/backend .
EXPOSE 3001
CMD ["./backend"]
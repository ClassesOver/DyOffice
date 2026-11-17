//! Explicit test build only. No listener, document bytes, engine or system bus.
use dyoffice_document_broker::{decode_frame, protocol::MAX_FRAME, transport::ProbeBroker};
use std::io::{Read, Write};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
#[tokio::main]
async fn main() {
    if std::env::var("DOCUMENT_BROKER_TEST_HARNESS").as_deref() != Ok("1") {
        std::process::exit(78);
    }
    // Fixed test faults only; default builds cannot compile this example.
    if let Ok(fault) = std::env::var("DOCUMENT_BROKER_TEST_FAULT") {
        match fault.as_str() {
            "stall" => std::thread::sleep(Duration::from_secs(3)),
            "stdout-flood" => {
                let _ = std::io::stdout().write_all(&[b'x'; 1025]);
                std::thread::sleep(Duration::from_secs(3));
            }
            "stderr-flood" => {
                let _ = std::io::stderr().write_all(&[b'x'; 1025]);
                std::thread::sleep(Duration::from_secs(3));
            }
            "partial" => {
                let _ = std::io::stdout().write_all(b"{\"protocolVersion\":");
            }
            "early-close" => {}
            _ => std::process::exit(78),
        }
        return;
    }
    if run().await.is_err() {
        std::process::exit(78);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_FRAME + 1) as u64)
        .read_to_end(&mut bytes)?;
    let frame = decode_frame(&bytes).map_err(|_| "invalid control frame")?;
    let (server, mut client) = UnixStream::pair()?;
    let broker = ProbeBroker::new(frame, server.peer_cred()?.uid()).map_err(|_| "invalid peer")?;
    let (served, reply) = tokio::join!(broker.serve_one(server, Duration::from_secs(1)), async {
        client.write_u32(bytes.len() as u32).await?;
        client.write_all(&bytes).await?;
        client.shutdown().await?;
        let length = client.read_u32().await? as usize;
        if length > 1024 {
            return Err(std::io::Error::other("oversized denial"));
        }
        let mut response = vec![0; length];
        client.read_exact(&mut response).await?;
        Ok::<_, std::io::Error>(response)
    });
    served.map_err(|_| "broker refused transport")?;
    std::io::stdout().write_all(&reply?)?;
    Ok(())
}

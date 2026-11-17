use dyoffice_document_broker::{
    decode_frame,
    protocol::{Denial, Error, Operation, Status},
    transport::ProbeBroker,
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};
const GOLDEN: &[u8] = include_bytes!("fixtures/control-frame.json");
fn pair() -> (UnixStream, UnixStream) {
    UnixStream::pair().unwrap()
}
fn broker() -> ProbeBroker {
    let (a, _b) = pair();
    ProbeBroker::new(decode_frame(GOLDEN).unwrap(), a.peer_cred().unwrap().uid()).unwrap()
}
async fn send(mut client: UnixStream, bytes: &[u8]) -> Denial {
    client.write_u32(bytes.len() as u32).await.unwrap();
    client.write_all(bytes).await.unwrap();
    client.shutdown().await.unwrap();
    let len = client.read_u32().await.unwrap() as usize;
    assert!(len <= 1024);
    let mut result = vec![0; len];
    client.read_exact(&mut result).await.unwrap();
    serde_json::from_slice(&result).unwrap()
}
#[tokio::test]
async fn actual_socketpair_reads_credentials_and_every_operation_is_disabled() {
    for op in [Operation::Probe, Operation::Start, Operation::Stop] {
        let b = broker();
        let (server, client) = pair();
        let mut f = decode_frame(GOLDEN).unwrap();
        f.operation = op;
        let bytes = serde_json::to_vec(&f).unwrap();
        let (result, response) = tokio::join!(
            b.serve_one(server, Duration::from_secs(1)),
            send(client, &bytes)
        );
        assert_eq!(result, Ok(()));
        assert_eq!(response.status, Status::Disabled);
        assert_eq!(response.request_id, f.request_id)
    }
}
#[tokio::test]
async fn wrong_peer_context_or_instance_never_receives_admission() {
    let (server, _client) = pair();
    let uid = server.peer_cred().unwrap().uid();
    let b = ProbeBroker::new(decode_frame(GOLDEN).unwrap(), uid + 1).unwrap();
    assert_eq!(
        b.serve_one(server, Duration::from_millis(100)).await,
        Err(Error::Peer)
    );
    for field in ["brokerBootId", "context", "request"] {
        let mut v: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
        match field {
            "brokerBootId" => v[field] = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into(),
            "context" => v[field]["version"] = 2.into(),
            _ => v[field]["jobEpoch"] = 2.into(),
        };
        let bytes = serde_json::to_vec(&v).unwrap();
        let (server, mut client) = pair();
        client.write_u32(bytes.len() as u32).await.unwrap();
        client.write_all(&bytes).await.unwrap();
        client.shutdown().await.unwrap();
        assert_eq!(
            broker().serve_one(server, Duration::from_secs(1)).await,
            Err(Error::Identity)
        )
    }
}
#[tokio::test]
async fn oversized_header_duplicate_frame_and_partial_eof_reject() {
    for length in [0, 65537, u32::MAX] {
        let (server, mut client) = pair();
        client.write_u32(length).await.unwrap();
        assert_eq!(
            broker().serve_one(server, Duration::from_millis(100)).await,
            Err(Error::Limit)
        )
    }
    let (server, mut client) = pair();
    client.write_u32(GOLDEN.len() as u32).await.unwrap();
    client.write_all(GOLDEN).await.unwrap();
    client.write_all(&[0]).await.unwrap();
    client.shutdown().await.unwrap();
    assert_eq!(
        broker().serve_one(server, Duration::from_secs(1)).await,
        Err(Error::Protocol)
    );
    for bytes in [vec![0, 1], vec![0, 0, 0, 10, 1, 2]] {
        let (server, mut client) = pair();
        client.write_all(&bytes).await.unwrap();
        client.shutdown().await.unwrap();
        assert_eq!(
            broker().serve_one(server, Duration::from_secs(1)).await,
            Err(Error::Disconnected)
        )
    }
}
#[tokio::test]
async fn absolute_deadline_bounds_slow_header_body_and_missing_halfclose() {
    for part in [vec![], vec![0], vec![0, 0, 0, 5, 1]] {
        let (server, mut client) = pair();
        client.write_all(&part).await.unwrap();
        assert_eq!(
            broker().serve_one(server, Duration::from_millis(20)).await,
            Err(Error::Timeout)
        )
    }
    let (server, mut client) = pair();
    client.write_u32(GOLDEN.len() as u32).await.unwrap();
    client.write_all(GOLDEN).await.unwrap();
    assert_eq!(
        broker().serve_one(server, Duration::from_millis(20)).await,
        Err(Error::Timeout)
    )
}
#[tokio::test]
async fn admission_slots_and_replay_cache_are_shared_and_bounded() {
    let b = broker();
    let (s1, _c1) = pair();
    let (s2, _c2) = pair();
    let (s3, _c3) = pair();
    let a = b.clone();
    let c = b.clone();
    let first = tokio::spawn(async move { a.serve_one(s1, Duration::from_millis(80)).await });
    let second = tokio::spawn(async move { c.serve_one(s2, Duration::from_millis(80)).await });
    tokio::task::yield_now().await;
    assert_eq!(
        b.serve_one(s3, Duration::from_millis(10)).await,
        Err(Error::Busy)
    );
    assert_eq!(first.await.unwrap(), Err(Error::Timeout));
    assert_eq!(second.await.unwrap(), Err(Error::Timeout));
    let (s, c) = pair();
    let (result, _) = tokio::join!(b.serve_one(s, Duration::from_secs(1)), send(c, GOLDEN));
    assert_eq!(result, Ok(()));
    let (s, mut c) = pair();
    c.write_u32(GOLDEN.len() as u32).await.unwrap();
    c.write_all(GOLDEN).await.unwrap();
    c.shutdown().await.unwrap();
    assert_eq!(
        b.serve_one(s, Duration::from_secs(1)).await,
        Err(Error::Replay)
    )
}
#[tokio::test]
async fn slowly_dripped_header_uses_one_deadline() {
    let (server, mut client) = pair();
    let slow = tokio::spawn(async move {
        for byte in [0, 0, 0, 1, 0] {
            tokio::time::sleep(Duration::from_millis(8)).await;
            if client.write_all(&[byte]).await.is_err() {
                break;
            }
        }
    });
    assert_eq!(
        broker().serve_one(server, Duration::from_millis(20)).await,
        Err(Error::Timeout)
    );
    slow.await.unwrap()
}
#[tokio::test]
async fn replay_memory_has_a_hard_lifetime_cap() {
    let b = broker();
    for n in 0..1024 {
        let mut frame = decode_frame(GOLDEN).unwrap();
        frame.request_id = format!("cccccccc-cccc-cccc-cccc-{n:012x}");
        let bytes = serde_json::to_vec(&frame).unwrap();
        let (s, c) = pair();
        let (result, _) = tokio::join!(b.serve_one(s, Duration::from_secs(1)), send(c, &bytes));
        assert_eq!(result, Ok(()))
    }
    let mut frame = decode_frame(GOLDEN).unwrap();
    frame.request_id = "dddddddd-dddd-dddd-dddd-dddddddddddd".into();
    let bytes = serde_json::to_vec(&frame).unwrap();
    let (s, mut c) = pair();
    c.write_u32(bytes.len() as u32).await.unwrap();
    c.write_all(&bytes).await.unwrap();
    c.shutdown().await.unwrap();
    assert_eq!(
        b.serve_one(s, Duration::from_secs(1)).await,
        Err(Error::Busy)
    )
}
#[tokio::test]
async fn exact_64k_control_frame_is_admitted_only_to_disabled_reply() {
    let b = broker();
    let mut bytes = GOLDEN.to_vec();
    bytes.resize(65536, b' ');
    let (server, client) = pair();
    let (result, denied) = tokio::join!(
        b.serve_one(server, Duration::from_secs(1)),
        send(client, &bytes)
    );
    assert_eq!(result, Ok(()));
    assert_eq!(denied.status, Status::Disabled);
}

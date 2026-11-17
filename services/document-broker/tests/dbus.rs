use dyoffice_document_broker::systemd_probe::{candidate_properties, probe};
use zbus::{connection::Builder, zvariant::OwnedValue};
struct FakeManager;
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl FakeManager {
    #[zbus(property)]
    fn version(&self) -> &str {
        "fake-manager-not-systemd"
    }
    fn inspect_candidate(&self, values: Vec<(String, OwnedValue)>) -> bool {
        if values.len() != 6 {
            return false;
        }
        let boolean = |name: &str| {
            values
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, v)| bool::try_from(v).ok())
                == Some(true)
        };
        let number = |name: &str| {
            values
                .iter()
                .find(|(n, _)| n == name)
                .and_then(|(_, v)| u64::try_from(v).ok())
        };
        boolean("NoNewPrivileges")
            && boolean("PrivateNetwork")
            && boolean("PrivateDevices")
            && number("MemoryMax") == Some(512 * 1024 * 1024)
            && number("TasksMax") == Some(64)
            && values
                .iter()
                .find(|(n, _)| n == "ProtectSystem")
                .and_then(|(_, v)| <&str>::try_from(v).ok())
                == Some("strict")
    }
}
#[tokio::test]
async fn actual_zbus_p2p_checks_typed_properties_and_probe_without_real_system_manager() {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let (s, c) = tokio::net::UnixStream::pair().unwrap();
        let guid = zbus::Guid::generate();
        let server = Builder::unix_stream(s)
            .server(guid)
            .unwrap()
            .p2p()
            .serve_at("/org/freedesktop/systemd1", FakeManager)
            .unwrap()
            .build();
        let client = Builder::unix_stream(c).p2p().build();
        let (_server, client) = tokio::try_join!(server, client).unwrap();
        let p = probe(&client).await.unwrap();
        assert_eq!(p.version, "fake-manager-not-systemd");
        assert!(!p.execution_available);
        let proxy = zbus::Proxy::new(
            &client,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )
        .await
        .unwrap();
        let accepted: bool = proxy
            .call("InspectCandidate", &(candidate_properties(),))
            .await
            .unwrap();
        assert!(accepted);
        let denied: bool = proxy
            .call(
                "InspectCandidate",
                &(vec![("ExecStart".to_string(), OwnedValue::from(true))],),
            )
            .await
            .unwrap();
        assert!(!denied);
    })
    .await
    .unwrap()
}
struct SlowManager;
#[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
impl SlowManager {
    #[zbus(property)]
    async fn version(&self) -> &str {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        "too-late"
    }
}
#[tokio::test]
async fn no_reply_and_disconnected_manager_probes_are_bounded() {
    let (s, c) = tokio::net::UnixStream::pair().unwrap();
    let guid = zbus::Guid::generate();
    let server = Builder::unix_stream(s)
        .server(guid)
        .unwrap()
        .p2p()
        .serve_at("/org/freedesktop/systemd1", SlowManager)
        .unwrap()
        .build();
    let client = Builder::unix_stream(c).p2p().build();
    let (server, client) = tokio::try_join!(server, client).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_millis(300), probe(&client)).await;
    assert!(outcome.is_ok(), "whole metadata probe exceeded bound");
    assert!(outcome.unwrap().is_err());
    server.close().await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), probe(&client))
            .await
            .unwrap()
            .is_err()
    );
}

//! Typed D-Bus metadata probe. No StartTransientUnit or StopUnit implementation.
use zbus::zvariant::{OwnedValue, Value};
/// Fixed candidate values, not an accepted unit policy. No ExecStart, path or unit name.
pub fn candidate_properties() -> Vec<(String, OwnedValue)> {
    vec![
        ("NoNewPrivileges".into(), true.into()),
        ("PrivateNetwork".into(), true.into()),
        ("PrivateDevices".into(), true.into()),
        ("MemoryMax".into(), (512u64 * 1024 * 1024).into()),
        ("TasksMax".into(), 64u64.into()),
        (
            "ProtectSystem".into(),
            Value::from("strict").try_to_owned().expect("static string"),
        ),
    ]
}
#[derive(Debug, PartialEq, Eq)]
pub struct ManagerProbe {
    pub version: String,
    pub execution_available: bool,
}
pub async fn probe(connection: &zbus::Connection) -> zbus::Result<ManagerProbe> {
    tokio::time::timeout(std::time::Duration::from_millis(100), async {
        let proxy = zbus::Proxy::new(
            connection,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )
        .await?;
        let version: String = proxy.get_property("Version").await?;
        if version.is_empty() || version.len() > 128 || version.chars().any(char::is_control) {
            return Err(zbus::Error::Failure("Invalid manager metadata".into()));
        }
        Ok(ManagerProbe {
            version,
            execution_available: false,
        })
    })
    .await
    .map_err(|_| zbus::Error::Failure("Manager probe timed out".into()))?
}

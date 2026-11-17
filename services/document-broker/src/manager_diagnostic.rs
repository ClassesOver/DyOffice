//! Fixed system-bus diagnostic, never an execution-admission certificate.

use serde::Serialize;
use std::{future::Future, time::Duration};
use zbus::{connection::Builder, fdo::DBusProxy, names::UniqueName};

const ADDRESS: &str = "unix:path=/run/dbus/system_bus_socket";
const SERVICE: &str = "org.freedesktop.systemd1";
const BUDGET: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unavailable {
    Connection,
    Manager,
    Identity,
    Metadata,
    OwnerChanged,
    Timeout,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ManagerObservation {
    scope: &'static str,
    manager_owner: String,
    manager_uid: u32,
    manager_pid: u32,
    manager_version: String,
    execution_available: bool,
}

fn validate_observation(
    owner: &str,
    uid: u32,
    pid: u32,
    version: &str,
    final_owner: &str,
) -> Result<ManagerObservation, Unavailable> {
    if UniqueName::try_from(owner).is_err() || uid != 0 || pid != 1 {
        return Err(Unavailable::Identity);
    }
    if owner != final_owner {
        return Err(Unavailable::OwnerChanged);
    }
    if version.is_empty() || version.len() > 128 || version.chars().any(char::is_control) {
        return Err(Unavailable::Metadata);
    }
    Ok(ManagerObservation {
        scope: "read-only-system-manager-observation",
        manager_owner: owner.into(),
        manager_uid: uid,
        manager_pid: pid,
        manager_version: version.into(),
        execution_available: false,
    })
}

async fn within_budget<T>(
    budget: Duration,
    work: impl Future<Output = Result<T, Unavailable>>,
) -> Result<T, Unavailable> {
    tokio::time::timeout(budget, work)
        .await
        .map_err(|_| Unavailable::Timeout)?
}

/// A fixed real endpoint only. No caller-supplied connection, path or environment
/// override. UID/PID are bus observations, not authentication of a hostile host.
/// No mutating Manager API exists in this module.
pub async fn inspect_system_manager() -> Result<ManagerObservation, Unavailable> {
    within_budget(BUDGET, async {
        // Do not use Connection::system(): DBUS_SYSTEM_BUS_ADDRESS must not reroute us.
        let connection = Builder::address(ADDRESS)
            .map_err(|_| Unavailable::Connection)?
            .build()
            .await
            .map_err(|_| Unavailable::Connection)?;
        let bus = DBusProxy::new(&connection)
            .await
            .map_err(|_| Unavailable::Connection)?;
        let service = SERVICE.try_into().map_err(|_| Unavailable::Identity)?;
        let owner = bus
            .get_name_owner(service)
            .await
            .map_err(|_| Unavailable::Manager)?;
        let uid = bus
            .get_connection_unix_user(owner.clone().into())
            .await
            .map_err(|_| Unavailable::Identity)?;
        let pid = bus
            .get_connection_unix_process_id(owner.clone().into())
            .await
            .map_err(|_| Unavailable::Identity)?;
        // Reject before reading any manager metadata from an unexpected principal.
        if uid != 0 || pid != 1 {
            return Err(Unavailable::Identity);
        }
        let version = read_version(&connection, owner.as_str()).await?;
        let final_owner = bus
            .get_name_owner(SERVICE.try_into().map_err(|_| Unavailable::Identity)?)
            .await
            .map_err(|_| Unavailable::OwnerChanged)?;
        validate_observation(owner.as_str(), uid, pid, &version, final_owner.as_str())
    })
    .await
}

async fn read_version(connection: &zbus::Connection, owner: &str) -> Result<String, Unavailable> {
    // No cache: Version must issue only Properties.Get, never GetAll or a
    // PropertiesChanged subscription that could expose Manager Environment.
    let manager: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
        .destination(owner)
        .map_err(|_| Unavailable::Identity)?
        .path("/org/freedesktop/systemd1")
        .map_err(|_| Unavailable::Manager)?
        .interface("org.freedesktop.systemd1.Manager")
        .map_err(|_| Unavailable::Manager)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await
        .map_err(|_| Unavailable::Manager)?;
    let version: String = manager
        .get_property("Version")
        .await
        .map_err(|_| Unavailable::Metadata)?;
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_observation_is_always_non_executable() {
        let observed = validate_observation(":1.7", 0, 1, "256 (256.1)", ":1.7").unwrap();
        assert!(!observed.execution_available);
        assert_eq!(observed.manager_owner, ":1.7");
    }

    #[test]
    fn rejects_missing_or_changed_identity() {
        for (owner, uid, pid, final_owner) in [
            ("org.freedesktop.systemd1", 0, 1, "org.freedesktop.systemd1"),
            (":", 0, 1, ":"),
            (":1.7", 1000, 1, ":1.7"),
            (":1.7", 0, 2, ":1.7"),
            (":1.7", 0, 1, ":1.8"),
        ] {
            assert!(validate_observation(owner, uid, pid, "256", final_owner).is_err());
        }
    }

    #[test]
    fn rejects_unbounded_or_control_metadata() {
        for version in ["", "256\n", "256\0", &"x".repeat(129)] {
            assert_eq!(
                validate_observation(":1.7", 0, 1, version, ":1.7"),
                Err(Unavailable::Metadata)
            );
        }
        assert!(validate_observation(":1.7", 0, 1, &"x".repeat(128), ":1.7").is_ok());
    }

    #[tokio::test]
    async fn one_deadline_covers_all_pending_work() {
        let result = within_budget(std::time::Duration::from_millis(10), async {
            std::future::pending::<()>().await;
            Ok(())
        })
        .await;
        assert_eq!(result, Err(Unavailable::Timeout));
    }
    // Protocol regression only: this peer is not a real or authenticated manager.
    #[tokio::test]
    async fn version_read_does_not_fetch_other_manager_properties() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        struct Fixture(Arc<AtomicUsize>);
        #[zbus::interface(name = "org.freedesktop.systemd1.Manager")]
        impl Fixture {
            #[zbus(property)]
            fn version(&self) -> &str {
                "fixture-version"
            }
            #[zbus(property)]
            fn environment(&self) -> Vec<String> {
                self.0.fetch_add(1, Ordering::SeqCst);
                vec!["FIXTURE_ONLY=1".into()]
            }
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            let reads = Arc::new(AtomicUsize::new(0));
            let (s, c) = tokio::net::UnixStream::pair().unwrap();
            let server = Builder::unix_stream(s)
                .server(zbus::Guid::generate())
                .unwrap()
                .p2p()
                .serve_at("/org/freedesktop/systemd1", Fixture(reads.clone()))
                .unwrap()
                .build();
            let client = Builder::unix_stream(c).p2p().build();
            let (_server, client) = tokio::try_join!(server, client).unwrap();
            assert_eq!(
                read_version(&client, ":1.7").await.unwrap(),
                "fixture-version"
            );
            assert_eq!(
                reads.load(Ordering::SeqCst),
                0,
                "must not invoke GetAll/Environment"
            );
        })
        .await
        .unwrap();
    }
}

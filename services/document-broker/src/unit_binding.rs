//! Private point-in-time unit identity observation, never runtime admission or
//! cgroup ownership/emptiness proof. Caller owns deadline, cancellation and the
//! pinned manager-owner observation window.
use zbus::{proxy::CacheProperties, zvariant::OwnedObjectPath};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct UnitBinding {
    object_path: String,
    unit_id: String,
    invocation_id: Vec<u8>,
    control_group: String,
}
impl UnitBinding {
    pub(super) fn object_path(&self) -> &str {
        &self.object_path
    }
    pub(super) fn control_group(&self) -> &str {
        &self.control_group
    }
}

fn validate(
    path: &str,
    expected: &str,
    id: &str,
    invocation: Vec<u8>,
    cgroup: &str,
) -> Result<UnitBinding, ()> {
    if expected.is_empty()
        || expected.len() > 128
        || id != expected
        || path.len() > 1024
        || !path
            .strip_prefix("/org/freedesktop/systemd1/unit/")
            .is_some_and(|tail| !tail.is_empty() && !tail.contains('/'))
        || invocation.len() != 16
        || invocation.iter().all(|byte| *byte == 0)
        || cgroup.len() > 4096
        || !cgroup.starts_with('/')
        || cgroup == "/"
        || cgroup
            .bytes()
            .any(|byte| !(0x21..=0x7e).contains(&byte) || byte == b'\\')
        || cgroup[1..]
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(());
    }
    Ok(UnitBinding {
        object_path: path.into(),
        unit_id: id.into(),
        invocation_id: invocation,
        control_group: cgroup.into(),
    })
}

pub(super) async fn read(
    connection: &zbus::Connection,
    destination: &str,
    expected: &str,
) -> Result<UnitBinding, ()> {
    // No environment address, path synthesis, GetAll, or property cache.
    let manager: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
        .destination(destination)
        .map_err(|_| ())?
        .path("/org/freedesktop/systemd1")
        .map_err(|_| ())?
        .interface("org.freedesktop.systemd1.Manager")
        .map_err(|_| ())?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|_| ())?;
    let path: OwnedObjectPath = manager
        .call("GetUnit", &(expected,))
        .await
        .map_err(|_| ())?;
    if path.as_str().len() > 1024
        || !path
            .as_str()
            .strip_prefix("/org/freedesktop/systemd1/unit/")
            .is_some_and(|tail| !tail.is_empty() && !tail.contains('/'))
    {
        return Err(());
    }
    let unit: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
        .destination(destination)
        .map_err(|_| ())?
        .path(path.as_str())
        .map_err(|_| ())?
        .interface("org.freedesktop.systemd1.Unit")
        .map_err(|_| ())?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|_| ())?;
    let service: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
        .destination(destination)
        .map_err(|_| ())?
        .path(path.as_str())
        .map_err(|_| ())?
        .interface("org.freedesktop.systemd1.Service")
        .map_err(|_| ())?
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .map_err(|_| ())?;
    async fn snapshot(
        unit: &zbus::Proxy<'_>,
        service: &zbus::Proxy<'_>,
        path: &str,
        expected: &str,
    ) -> Result<UnitBinding, ()> {
        let invocation: Vec<u8> = unit.get_property("InvocationID").await.map_err(|_| ())?;
        let id: String = unit.get_property("Id").await.map_err(|_| ())?;
        let cgroup: String = service.get_property("ControlGroup").await.map_err(|_| ())?;
        validate(path, expected, &id, invocation, &cgroup)
    }
    let first = snapshot(&unit, &service, path.as_str(), expected).await?;
    // Identity snapshots bracket both uncached configuration reads. This only
    // observes the manager's declared settings, never kernel enforcement.
    read_fixed_security(&service).await?;
    read_fixed_security(&service).await?;
    let second = snapshot(&unit, &service, path.as_str(), expected).await?;
    let final_path: OwnedObjectPath = manager
        .call("GetUnit", &(expected,))
        .await
        .map_err(|_| ())?;
    if first != second || final_path != path {
        return Err(());
    }
    Ok(first)
}

// systemd v255 Service interface / dbus-execute.c exec-context vtable.
// The canonical enum strings are protect_*_table in core/namespace.c.
// Deliberately a fixed subset, not a complete launch-policy certificate.
async fn read_fixed_security(service: &zbus::Proxy<'_>) -> Result<(), ()> {
    for name in [
        "NoNewPrivileges",
        "PrivateNetwork",
        "PrivateDevices",
        "RestrictSUIDSGID",
        "LockPersonality",
    ] {
        let enabled: bool = service.get_property(name).await.map_err(|_| ())?;
        if !enabled {
            return Err(());
        }
    }
    for (name, expected) in [("ProtectSystem", "strict"), ("ProtectHome", "yes")] {
        let actual: String = service.get_property(name).await.map_err(|_| ())?;
        if actual != expected {
            return Err(());
        }
    }
    let caps: u64 = service
        .get_property("CapabilityBoundingSet")
        .await
        .map_err(|_| ())?;
    if caps != 0 {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PATH: &str = "/org/freedesktop/systemd1/unit/non_derived";
    #[test]
    fn rejects_root_traversal_empty_unbounded_and_control_paths() {
        for value in [
            "", "/", "relative", "/a/../b", "/a/./b", "/a//b", "/a/", "/a b", "/a\nb", "/a\\b",
        ] {
            assert!(validate(PATH, "x.service", "x.service", vec![1; 16], value).is_err());
        }
        assert!(
            validate(
                PATH,
                "x.service",
                "x.service",
                vec![1; 16],
                &format!("/{}", "a".repeat(4096))
            )
            .is_err()
        );
    }
    #[test]
    fn requires_exact_unit_and_nonzero_invocation() {
        for id in [vec![], vec![1; 15], vec![1; 17], vec![0; 16]] {
            assert!(validate(PATH, "x.service", "x.service", id, "/a/b").is_err());
        }
        assert!(validate(PATH, "x.service", "y.service", vec![1; 16], "/a/b").is_err());
        assert!(validate("/arbitrary", "x.service", "x.service", vec![1; 16], "/a/b").is_err());
        assert!(validate(PATH, "x.service", "x.service", vec![1; 16], "/a/b").is_ok());
    }
}

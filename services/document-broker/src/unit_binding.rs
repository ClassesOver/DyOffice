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
    spec: &crate::launch_spec::LaunchSpec,
) -> Result<UnitBinding, ()> {
    let expected = spec.unit();
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
    read_resource_policy(&service, spec).await?;
    read_fixed_security(&service).await?;
    read_resource_policy(&service, spec).await?;
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

// Exact manager-declared values, not effective kernel limits or cleanup authority.
// Derive expectations from the same private spec used for submission (including
// test-only container probe overrides), never from caller-provided properties.
async fn read_resource_policy(
    service: &zbus::Proxy<'_>,
    spec: &crate::launch_spec::LaunchSpec,
) -> Result<(), ()> {
    let properties = spec.properties();
    let expected = |name: &str| {
        let mut found = properties.iter().filter(|(key, _)| key == name);
        let value = &found.next().ok_or(())?.1;
        if found.next().is_some() {
            return Err(());
        }
        Ok(value)
    };
    for name in [
        "MemoryMax",
        "MemorySwapMax",
        "TasksMax",
        "CPUQuotaPerSecUSec",
        "RuntimeMaxUSec",
        "TimeoutStopUSec",
    ] {
        let actual: u64 = service.get_property(name).await.map_err(|_| ())?;
        if actual != u64::try_from(expected(name)?).map_err(|_| ())? {
            return Err(());
        }
    }
    let mask: u32 = service.get_property("UMask").await.map_err(|_| ())?;
    if mask != u32::try_from(expected("UMask")?).map_err(|_| ())? {
        return Err(());
    }
    let mode: String = service.get_property("KillMode").await.map_err(|_| ())?;
    if mode != <&str>::try_from(expected("KillMode")?).map_err(|_| ())? {
        return Err(());
    }
    Ok(())
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
    struct ProbeResources;
    #[zbus::interface(name = "org.freedesktop.systemd1.Service")]
    impl ProbeResources {
        #[zbus(property)]
        fn memory_max(&self) -> u64 {
            64_000_000
        }
        #[zbus(property)]
        fn memory_swap_max(&self) -> u64 {
            0
        }
        #[zbus(property)]
        fn tasks_max(&self) -> u64 {
            8
        }
        #[zbus(property, name = "CPUQuotaPerSecUSec")]
        fn cpu(&self) -> u64 {
            1_000_000
        }
        #[zbus(property, name = "RuntimeMaxUSec")]
        fn runtime(&self) -> u64 {
            2_000_000
        }
        #[zbus(property, name = "TimeoutStopUSec")]
        fn stop(&self) -> u64 {
            5_000_000
        }
        #[zbus(property, name = "UMask")]
        fn mask(&self) -> u32 {
            63
        }
        #[zbus(property)]
        fn kill_mode(&self) -> &str {
            "control-group"
        }
    }
    #[tokio::test]
    async fn probe_budget_is_read_from_its_spec_not_default_fixture() {
        use zbus::connection::Builder;
        let (s, c) = tokio::net::UnixStream::pair().unwrap();
        let guid = zbus::Guid::generate();
        let server = Builder::unix_stream(s)
            .server(guid)
            .unwrap()
            .p2p()
            .serve_at(PATH, ProbeResources)
            .unwrap()
            .build();
        let client = Builder::unix_stream(c).p2p().build();
        let (server, client) = tokio::join!(server, client);
        let _server = server.unwrap();
        let client = client.unwrap();
        let service: zbus::Proxy<'_> = zbus::proxy::Builder::new(&client)
            .destination("org.freedesktop.systemd1")
            .unwrap()
            .path(PATH)
            .unwrap()
            .interface("org.freedesktop.systemd1.Service")
            .unwrap()
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .unwrap();
        assert!(
            read_resource_policy(&service, &crate::launch_spec::LaunchSpec::container_probe())
                .await
                .is_ok()
        );
        assert!(
            read_resource_policy(&service, &crate::launch_spec::LaunchSpec::fixture())
                .await
                .is_err()
        );
    }
}

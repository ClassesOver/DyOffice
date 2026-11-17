//! Private typed launch configuration. No production runtime can yet be approved.
use zbus::zvariant::{OwnedValue, Value};

// Uninhabited until a separately reviewed provenance/rootfs admission is implemented.
pub(super) enum ApprovedRuntime {}
pub(super) struct LaunchSpec {
    unit: String,
    root: String,
    executable: String,
}
impl LaunchSpec {
    pub(super) fn from_approved(runtime: ApprovedRuntime) -> Self {
        match runtime {}
    }
    pub(super) fn unit(&self) -> &str {
        &self.unit
    }
    pub(super) fn properties(&self) -> Vec<(String, OwnedValue)> {
        // Fixed typed setters; no caller-provided property deserialization.
        let mut p: Vec<(String, OwnedValue)> = vec![
            ("NoNewPrivileges".into(), true.into()),
            ("PrivateNetwork".into(), true.into()),
            ("PrivateDevices".into(), true.into()),
            (
                "ProtectSystem".into(),
                Value::from("strict").try_into().unwrap(),
            ),
            ("ProtectHome".into(), Value::from("yes").try_into().unwrap()),
            ("MemoryMax".into(), (512 * 1024 * 1024u64).into()),
            ("MemorySwapMax".into(), 0u64.into()),
            ("TasksMax".into(), 64u64.into()),
            ("CPUQuotaPerSecUSec".into(), 1_000_000u64.into()),
            ("CapabilityBoundingSet".into(), 0u64.into()),
            ("RestrictSUIDSGID".into(), true.into()),
            ("LockPersonality".into(), true.into()),
            ("UMask".into(), 63u32.into()),
            (
                "KillMode".into(),
                Value::from("control-group").try_into().unwrap(),
            ),
            ("RuntimeMaxUSec".into(), 30_000_000u64.into()),
            ("TimeoutStopUSec".into(), 5_000_000u64.into()),
            (
                "RootDirectory".into(),
                Value::from(self.root.as_str()).try_into().unwrap(),
            ),
            (
                "WorkingDirectory".into(),
                Value::from("/").try_into().unwrap(),
            ),
        ];
        let command = vec![(
            self.executable.clone(),
            vec![self.executable.clone()],
            false,
        )];
        p.push(("ExecStart".into(), Value::from(command).try_into().unwrap()));
        #[cfg(test)]
        if self.unit == "dyoffice-container-probe.service" {
            p.retain(|(k, _)| {
                !matches!(
                    k.as_str(),
                    "ExecStart" | "RuntimeMaxUSec" | "MemoryMax" | "TasksMax"
                )
            });
            p.extend([
                (
                    "ExecStart".into(),
                    Value::from(vec![(
                        "/usr/bin/sleep".to_owned(),
                        vec!["/usr/bin/sleep".to_owned(), "30".to_owned()],
                        false,
                    )])
                    .try_into()
                    .unwrap(),
                ),
                ("RuntimeMaxUSec".into(), 2_000_000u64.into()),
                ("MemoryMax".into(), 64_000_000u64.into()),
                ("TasksMax".into(), 8u64.into()),
                ("DynamicUser".into(), true.into()),
                ("PrivateTmp".into(), true.into()),
                (
                    "InaccessiblePaths".into(),
                    Value::from(vec![
                        "/run".to_owned(),
                        "/root".to_owned(),
                        "/home".to_owned(),
                    ])
                    .try_into()
                    .unwrap(),
                ),
            ]);
        }
        p
    }
    #[cfg(test)]
    pub(super) fn container_probe() -> Self {
        Self {
            unit: "dyoffice-container-probe.service".into(),
            root: "/".into(),
            executable: "/usr/bin/sleep".into(),
        }
    }
    #[cfg(test)]
    pub(super) fn fixture() -> Self {
        Self {
            unit: "dyoffice-fixture-readonly.service".into(),
            root: "/fixture-only-not-installed".into(),
            executable: "/fixture-only".into(),
        }
    }
}

#[cfg(test)]
mod container_probe_spec_tests {
    use super::*;
    #[test]
    fn probe_has_only_fixed_sleep_command_and_short_manager_deadline() {
        let spec = LaunchSpec::container_probe();
        assert_eq!(spec.unit(), "dyoffice-container-probe.service");
        let p = spec.properties();
        let get = |key| &p.iter().find(|(k, _)| k == key).unwrap().1;
        let command =
            Vec::<(String, Vec<String>, bool)>::try_from(get("ExecStart").try_clone().unwrap())
                .unwrap();
        assert_eq!(
            command,
            vec![(
                "/usr/bin/sleep".into(),
                vec!["/usr/bin/sleep".into(), "30".into()],
                false
            )]
        );
        assert_eq!(u64::try_from(get("RuntimeMaxUSec")).unwrap(), 2_000_000);
        assert_eq!(u64::try_from(get("CapabilityBoundingSet")).unwrap(), 0);
        for key in [
            "DynamicUser",
            "PrivateNetwork",
            "PrivateDevices",
            "NoNewPrivileges",
        ] {
            assert!(bool::try_from(get(key)).unwrap());
        }
        assert_eq!(<&str>::try_from(get("KillMode")).unwrap(), "control-group");
        let unique: std::collections::BTreeSet<_> = p.iter().map(|(k, _)| k).collect();
        assert_eq!(unique.len(), p.len());
    }
}

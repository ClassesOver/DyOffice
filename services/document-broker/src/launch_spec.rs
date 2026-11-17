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
        let mut p = vec![
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
        p
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

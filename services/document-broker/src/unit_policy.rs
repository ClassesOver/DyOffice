//! Configuration candidates only. No conversion to a launchable unit is exposed.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    InvalidSelection,
    UnsupportedCapabilities,
    UnsupportedRuntimeManifest,
}
#[derive(Debug, Clone, Copy, Deserialize)]
enum Profile {
    #[serde(rename = "xlsx-edit-v1")]
    Xlsx,
    #[serde(rename = "pptx-edit-v1")]
    Pptx,
    #[serde(rename = "docx-edit-v1")]
    Docx,
    #[serde(rename = "pdf-edit-v1")]
    Pdf,
}
impl Profile {
    fn id(self) -> &'static str {
        match self {
            Self::Xlsx => "xlsx-edit-v1",
            Self::Pptx => "pptx-edit-v1",
            Self::Docx => "docx-edit-v1",
            Self::Pdf => "pdf-edit-v1",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    profile_id: Profile,
    policy_version: u32,
}
/// This is intentionally not Serialize, a(sv), or an executable manifest.
/// No API accepts executable paths, arguments, environment, users, or unit names.
pub struct NonLaunchableUnitPolicy {
    profile: Profile,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    name: String,
    signature: String,
    value: Value,
}
impl NonLaunchableUnitPolicy {
    pub fn profile_id(&self) -> &'static str {
        self.profile.id()
    }
    pub fn requirements(&self) -> Vec<Requirement> {
        let b = |n: &str, v: bool| Requirement {
            name: n.into(),
            signature: "b".into(),
            value: v.into(),
        };
        let t = |n: &str, v: u64| Requirement {
            name: n.into(),
            signature: "t".into(),
            value: v.into(),
        };
        let s = |n: &str, v: &str| Requirement {
            name: n.into(),
            signature: "s".into(),
            value: v.into(),
        };
        vec![
            b("NoNewPrivileges", true),
            b("PrivateNetwork", true),
            b("PrivateDevices", true),
            s("ProtectSystem", "strict"),
            s("ProtectHome", "yes"),
            t("MemoryMax", 512 * 1024 * 1024),
            t("MemorySwapMax", 0),
            t("TasksMax", 64),
            t("CPUQuotaPerSecUSec", 1_000_000),
            t("CapabilityBoundingSet", 0),
            b("RestrictSUIDSGID", true),
            b("LockPersonality", true),
            Requirement {
                name: "UMask".into(),
                signature: "u".into(),
                value: 63u32.into(),
            },
            s("KillMode", "control-group"),
            t("RuntimeMaxUSec", 30_000_000),
            t("TimeoutStopUSec", 5_000_000),
        ]
    }
}
pub fn build_policy(bytes: &[u8]) -> Result<NonLaunchableUnitPolicy, PolicyError> {
    if bytes.len() > 1024 {
        return Err(PolicyError::InvalidSelection);
    }
    let selection: Selection =
        serde_json::from_slice(bytes).map_err(|_| PolicyError::InvalidSelection)?;
    if selection.policy_version != 1 {
        return Err(PolicyError::InvalidSelection);
    }
    Ok(NonLaunchableUnitPolicy {
        profile: selection.profile_id,
    })
}
pub fn resolve_launch(_policy: &NonLaunchableUnitPolicy) -> Result<(), PolicyError> {
    Err(PolicyError::UnsupportedRuntimeManifest)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureReport {
    report_scope: String,
    setter_schema: String,
    manager_version: String,
    architecture: String,
    profile_id: String,
    policy_version: u32,
    cgroup_version: u32,
    required_controllers: Vec<String>,
    selinux: String,
    namespace_probe: bool,
    seccomp_probe: bool,
    properties: Vec<Requirement>,
}
/// Match of caller-supplied TEST metadata, never an admission certificate.
pub struct FixtureConfigurationMatch {
    _private: (),
}
impl FixtureConfigurationMatch {
    pub fn execution_available(&self) -> bool {
        false
    }
}
pub fn verify_fixture_capabilities(
    policy: &NonLaunchableUnitPolicy,
    bytes: &[u8],
) -> Result<FixtureConfigurationMatch, PolicyError> {
    let denied = PolicyError::UnsupportedCapabilities;
    if bytes.len() > 16384 {
        return Err(denied);
    }
    let report: FixtureReport = serde_json::from_slice(bytes).map_err(|_| denied)?;
    if report.report_scope != "test-fixture"
        || report.setter_schema != "systemd-v256"
        || report.manager_version != "256"
        || report.architecture != "x86_64"
        || report.profile_id != policy.profile_id()
        || report.policy_version != 1
        || report.cgroup_version != 2
        || report.selinux != "enforcing"
        || !report.namespace_probe
        || !report.seccomp_probe
    {
        return Err(denied);
    }
    let controllers: BTreeSet<_> = report
        .required_controllers
        .iter()
        .map(String::as_str)
        .collect();
    if report.required_controllers.len() != 3
        || controllers != BTreeSet::from(["cpu", "memory", "pids"])
    {
        return Err(denied);
    }
    let expected = policy.requirements();
    if expected.len() != report.properties.len() {
        return Err(denied);
    }
    let mut seen = BTreeSet::new();
    for property in &report.properties {
        if !seen.insert(&property.name) || !expected.contains(property) {
            return Err(denied);
        }
    }
    Ok(FixtureConfigurationMatch { _private: () })
}
#[cfg(test)]
mod fixture {
    use super::*;
    use zbus::{
        connection::Builder,
        zvariant::{OwnedValue, Value as DbusValue},
    };
    // Fictional, fixed test manifest. No files are created and no method starts units.
    const ROOT: &str = "/__dyoffice_test__/root";
    const EXEC: &str = "/fixture/bin/readonly-engine";
    const USER: &str = "dyoffice-fixture";
    const WORK: &str = "/fixture/work";
    fn properties() -> Vec<(String, OwnedValue)> {
        let p = NonLaunchableUnitPolicy {
            profile: Profile::Pptx,
        };
        let mut values: Vec<_> = p
            .requirements()
            .into_iter()
            .map(|r| {
                let value = match r.signature.as_str() {
                    "b" => OwnedValue::from(r.value.as_bool().unwrap()),
                    "t" => OwnedValue::from(r.value.as_u64().unwrap()),
                    "u" => OwnedValue::from(r.value.as_u64().unwrap() as u32),
                    "s" => DbusValue::from(r.value.as_str().unwrap())
                        .try_to_owned()
                        .unwrap(),
                    _ => unreachable!(),
                };
                (r.name, value)
            })
            .collect();
        for (key, value) in [
            ("RootDirectory", ROOT),
            ("User", USER),
            ("WorkingDirectory", WORK),
        ] {
            values.push((key.into(), DbusValue::from(value).try_to_owned().unwrap()))
        }
        let exec = vec![(
            EXEC.to_owned(),
            vec![EXEC.to_owned(), "--fixture-readonly".to_owned()],
            false,
        )];
        values.push((
            "ExecStart".into(),
            DbusValue::from(exec).try_to_owned().unwrap(),
        ));
        values
    }
    fn fixture_unit_name(boot: [u8; 16], instance: [u8; 16]) -> String {
        let hex = |bytes: [u8; 16]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        format!("dyoffice-{}-{}.service", hex(boot), hex(instance))
    }
    #[test]
    fn unit_names_use_only_fixed_prefix_and_server_owned_binary_ids() {
        let name = fixture_unit_name([0xff; 16], [0; 16]);
        assert_eq!(
            name,
            format!("dyoffice-{}-{}.service", "ff".repeat(16), "00".repeat(16))
        );
        assert!(!name.contains('/') && !name.contains('%') && !name.contains(' '));
    }
    struct FakeReceiver;
    #[zbus::interface(name = "org.dyoffice.TestPolicy")]
    impl FakeReceiver {
        fn inspect_policy(&self, name: &str, values: Vec<(String, OwnedValue)>) -> bool {
            if name != fixture_unit_name([0x11; 16], [0x22; 16]) {
                return false;
            }
            if values.len() != 20 {
                return false;
            }
            let mut seen = BTreeSet::new();
            for (name, value) in &values {
                if !seen.insert(name.as_str()) {
                    return false;
                }
                if name == "ExecStart" {
                    if value.value_signature().to_string() != "a(sasb)" {
                        return false;
                    }
                    let Ok(exec) =
                        Vec::<(String, Vec<String>, bool)>::try_from(value.try_clone().unwrap())
                    else {
                        return false;
                    };
                    if exec
                        != vec![(
                            EXEC.into(),
                            vec![EXEC.into(), "--fixture-readonly".into()],
                            false,
                        )]
                    {
                        return false;
                    }
                } else if matches!(name.as_str(), "RootDirectory" | "User" | "WorkingDirectory") {
                    let expected = match name.as_str() {
                        "RootDirectory" => ROOT,
                        "User" => USER,
                        _ => WORK,
                    };
                    if <&str>::try_from(value).ok() != Some(expected) {
                        return false;
                    }
                } else {
                    let p = NonLaunchableUnitPolicy {
                        profile: Profile::Pptx,
                    };
                    let Some(r) = p.requirements().into_iter().find(|r| r.name == *name) else {
                        return false;
                    };
                    if value.value_signature().to_string() != r.signature {
                        return false;
                    }
                    let valid = match r.signature.as_str() {
                        "b" => bool::try_from(value).ok() == r.value.as_bool(),
                        "t" => u64::try_from(value).ok() == r.value.as_u64(),
                        "u" => u32::try_from(value).ok().map(u64::from) == r.value.as_u64(),
                        "s" => <&str>::try_from(value).ok() == r.value.as_str(),
                        _ => false,
                    };
                    if !valid {
                        return false;
                    }
                }
            }
            true
        }
    }
    #[tokio::test]
    async fn fixed_test_manifest_has_actual_setter_types_and_no_ignore_failure() {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let (s, c) = tokio::net::UnixStream::pair().unwrap();
            let guid = zbus::Guid::generate();
            let server = Builder::unix_stream(s)
                .server(guid)
                .unwrap()
                .p2p()
                .serve_at("/org/dyoffice/TestPolicy", FakeReceiver)
                .unwrap()
                .build();
            let client = Builder::unix_stream(c).p2p().build();
            let (_server, client) = tokio::try_join!(server, client).unwrap();
            let proxy = zbus::Proxy::new(
                &client,
                "org.dyoffice.TestPolicy",
                "/org/dyoffice/TestPolicy",
                "org.dyoffice.TestPolicy",
            )
            .await
            .unwrap();
            assert!(
                proxy
                    .call::<_, _, bool>(
                        "InspectPolicy",
                        &(fixture_unit_name([0x11; 16], [0x22; 16]), properties(),)
                    )
                    .await
                    .unwrap()
            );
            assert!(
                !proxy
                    .call::<_, _, bool>("InspectPolicy", &("sshd.service", properties(),))
                    .await
                    .unwrap()
            );
            let mut wrong = properties();
            wrong.push((
                "Environment".into(),
                DbusValue::from(vec!["LD_PRELOAD=/bad"])
                    .try_to_owned()
                    .unwrap(),
            ));
            assert!(
                !proxy
                    .call::<_, _, bool>(
                        "InspectPolicy",
                        &(fixture_unit_name([0x11; 16], [0x22; 16]), wrong,)
                    )
                    .await
                    .unwrap()
            );
            let mut wrong = properties();
            let exec = wrong.iter_mut().find(|(k, _)| k == "ExecStart").unwrap();
            exec.1 = DbusValue::from(vec![(
                EXEC.to_owned(),
                vec![EXEC.to_owned(), "--fixture-readonly".into()],
                true,
            )])
            .try_to_owned()
            .unwrap();
            assert!(
                !proxy
                    .call::<_, _, bool>(
                        "InspectPolicy",
                        &(fixture_unit_name([0x11; 16], [0x22; 16]), wrong,)
                    )
                    .await
                    .unwrap()
            );
        })
        .await
        .unwrap();
    }
}

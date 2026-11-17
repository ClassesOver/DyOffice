use dyoffice_document_broker::unit_policy::{
    PolicyError, build_policy, resolve_launch, verify_fixture_capabilities,
};
#[test]
fn all_known_profiles_remain_nonlaunchable() {
    for profile in [
        "xlsx-edit-v1",
        "pptx-edit-v1",
        "docx-edit-v1",
        "pdf-edit-v1",
    ] {
        let input = format!(r#"{{"profileId":"{profile}","policyVersion":1}}"#);
        let policy = build_policy(input.as_bytes()).unwrap();
        assert_eq!(policy.profile_id(), profile);
        assert_eq!(
            resolve_launch(&policy),
            Err(PolicyError::UnsupportedRuntimeManifest)
        );
    }
}
#[test]
fn caller_cannot_supply_unit_paths_commands_environment_or_versions() {
    for extra in [
        r#", "ExecStart":"/bin/sh""#,
        r#", "rootDirectory":"/tmp""#,
        r#", "argv":["-c","bad"]"#,
        r#", "environment":{"LD_PRELOAD":"x"}"#,
        r#", "unitName":"sshd.service""#,
        r#", "user":"root""#,
    ] {
        let input = format!(r#"{{"profileId":"pptx-edit-v1","policyVersion":1{extra}}}"#);
        assert!(build_policy(input.as_bytes()).is_err());
    }
    assert!(build_policy(br#"{"profileId":"../../evil","policyVersion":1}"#).is_err());
    assert!(build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":2}"#).is_err());
    assert!(
        build_policy(
            br#"{"profileId":"pptx-edit-v1","profileId":"pdf-edit-v1","policyVersion":1}"#
        )
        .is_err()
    );
    assert!(build_policy(&vec![b' '; 1025]).is_err());
}
fn report(
    policy: &dyoffice_document_broker::unit_policy::NonLaunchableUnitPolicy,
) -> serde_json::Value {
    serde_json::json!({"distribution":"openEuler","reportScope":"test-fixture","setterSchema":"systemd-v256","managerVersion":"256","architecture":"x86_64","profileId":policy.profile_id(),"policyVersion":1,"cgroupVersion":2,"requiredControllers":["cpu","memory","pids"],"selinux":"enforcing","namespaceProbe":true,"seccompProbe":true,"properties":policy.requirements()})
}
#[test]
fn exact_fixture_match_is_configuration_only_never_admission() {
    let p = build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":1}"#).unwrap();
    {
        let r = report(&p);
        let matched = verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(!matched.execution_available());
        assert_eq!(
            resolve_launch(&p),
            Err(PolicyError::UnsupportedRuntimeManifest)
        );
    }
}
#[test]
fn unknown_versions_missing_features_and_forged_certification_fail_closed() {
    let p = build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":1}"#).unwrap();
    for (key, value) in [
        ("managerVersion", serde_json::json!("257")),
        ("setterSchema", serde_json::json!("systemd-v255")),
        ("architecture", serde_json::json!("riscv64")),
        ("architecture", serde_json::json!("aarch64")),
        ("cgroupVersion", serde_json::json!(1)),
        ("selinux", serde_json::json!("permissive")),
        ("namespaceProbe", serde_json::json!(false)),
        ("seccompProbe", serde_json::json!(false)),
        ("requiredControllers", serde_json::json!(["cpu", "pids"])),
        ("reportScope", serde_json::json!("certified")),
        ("profileId", serde_json::json!("pdf-edit-v1")),
        ("extra", serde_json::json!(true)),
    ] {
        let mut r = report(&p);
        r[key] = value;
        assert!(
            verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).is_err(),
            "{key}"
        );
    }
}
#[test]
fn property_signature_value_duplicate_extra_and_missing_are_rejected() {
    let p = build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":1}"#).unwrap();
    for mode in 0..5 {
        let mut r = report(&p);
        let props = r["properties"].as_array_mut().unwrap();
        match mode {
            0 => {
                props[0]["signature"] = "s".into();
            }
            1 => {
                props[0]["value"] = false.into();
            }
            2 => {
                props.push(props[0].clone());
            }
            3 => {
                props
                    .push(serde_json::json!({"name":"ExecStart","signature":"a(sasb)","value":[]}));
            }
            _ => {
                props.pop();
            }
        }
        assert!(verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).is_err());
    }
}
#[test]
fn malformed_report_shapes_and_oversized_metadata_are_not_capabilities() {
    let p = build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":1}"#).unwrap();
    let mut missing = report(&p);
    missing.as_object_mut().unwrap().remove("namespaceProbe");
    assert!(verify_fixture_capabilities(&p, &serde_json::to_vec(&missing).unwrap()).is_err());
    for bytes in [
        b"null".to_vec(),
        vec![b' '; 16385],
        serde_json::to_vec(&report(&p))
            .unwrap()
            .into_iter()
            .chain(b" {}".iter().copied())
            .collect(),
    ] {
        assert!(verify_fixture_capabilities(&p, &bytes).is_err());
    }
    let text = serde_json::to_string(&report(&p)).unwrap();
    let duplicate = text.replacen(
        "\"managerVersion\":\"256\"",
        "\"managerVersion\":\"256\",\"managerVersion\":\"256\"",
        1,
    );
    assert!(verify_fixture_capabilities(&p, duplicate.as_bytes()).is_err());
}

#[test]
fn explicit_distribution_scope_never_certifies_either_target() {
    let p = build_policy(br#"{"profileId":"pptx-edit-v1","policyVersion":1}"#).unwrap();
    for distro in ["openEuler", "ubuntu"] {
        let mut r = report(&p);
        r["distribution"] = distro.into();
        let m = verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(!m.execution_available());
        assert_eq!(
            resolve_launch(&p),
            Err(PolicyError::UnsupportedRuntimeManifest)
        );
        r["architecture"] = "aarch64".into();
        assert!(verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).is_err());
    }
    for distro in ["debian", "Ubuntu", "", "fedora"] {
        let mut r = report(&p);
        r["distribution"] = distro.into();
        assert!(verify_fixture_capabilities(&p, &serde_json::to_vec(&r).unwrap()).is_err());
    }
    let mut missing = report(&p);
    missing.as_object_mut().unwrap().remove("distribution");
    assert!(verify_fixture_capabilities(&p, &serde_json::to_vec(&missing).unwrap()).is_err());
}

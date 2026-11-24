use dyoffice_document_broker::validate_frame;
const GOLDEN: &[u8] = include_bytes!("fixtures/control-frame.json");
#[test]
fn valid_control_frame_is_recognized() {
    assert!(validate_frame(GOLDEN));
}
#[test]
fn office_edit_profiles_share_the_generation_zero_control_frame() {
    let mut input: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    for (profile, accepted) in [
        ("docx-edit-v1", true),
        ("xlsx-edit-v1", true),
        ("pptx-edit-v1", true),
        ("pdf-edit-v1", false),
        ("xlsx-edit-v2", false),
    ] {
        input["request"]["profileId"] = profile.into();
        assert_eq!(
            validate_frame(&serde_json::to_vec(&input).unwrap()),
            accepted,
            "{profile}"
        );
    }
}
#[test]
fn untrusted_fields_and_numbers_are_not_protocol() {
    let original: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    for (key, value) in [
        ("protocolVersion", serde_json::json!(2)),
        ("requestId", serde_json::json!("../../unit")),
        ("operation", serde_json::json!("exec")),
        ("execStart", serde_json::json!("/bin/sh")),
    ] {
        let mut input = original.clone();
        input[key] = value;
        assert!(!validate_frame(&serde_json::to_vec(&input).unwrap()));
    }
    for n in [0, 9007199254740992u64, u64::MAX] {
        let mut input = original.clone();
        input["request"]["jobEpoch"] = n.into();
        assert!(!validate_frame(&serde_json::to_vec(&input).unwrap()));
    }
    let s = std::str::from_utf8(GOLDEN).unwrap();
    assert!(!validate_frame(
        s.replacen(
            "\"protocolVersion\": 1",
            "\"protocolVersion\": 1, \"protocolVersion\": 1",
            1
        )
        .as_bytes()
    ));
    assert!(!validate_frame(format!("{} {{}}", s).as_bytes()));
    assert!(!validate_frame(b"null"));
    assert!(!validate_frame(&vec![b' '; 65537]));
}
#[test]
fn canonical_deadline_matches_typescript_contract() {
    let mut input: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    for date in [
        "2030-01-01t00:00:20.000Z",
        "2030-01-01 00:00:20.000Z",
        "2030-01-01T00:00:20.00Z",
        "2030-02-30T00:00:20.000Z",
        "2030-01-01T00:00:60.000Z",
    ] {
        input["request"]["deadlineAt"] = date.into();
        assert!(
            !validate_frame(&serde_json::to_vec(&input).unwrap()),
            "{date}"
        )
    }
}
#[test]
fn null_negative_fractional_and_nested_duplicate_values_are_rejected() {
    let v: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    for value in [
        serde_json::Value::Null,
        serde_json::json!(-1),
        serde_json::json!(1.5),
        serde_json::json!("1"),
    ] {
        let mut input = v.clone();
        input["request"]["attempt"] = value;
        assert!(!validate_frame(&serde_json::to_vec(&input).unwrap()))
    }
    let s = std::str::from_utf8(GOLDEN).unwrap();
    assert!(!validate_frame(
        s.replacen("\"jobEpoch\": 1", "\"jobEpoch\": 1, \"jobEpoch\": 1", 1)
            .as_bytes()
    ));
    assert!(!validate_frame(&[255, 254]));
}

#[test]
fn default_binary_cannot_be_enabled_by_environment_or_arguments() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_dyoffice-document-broker"))
        .env("DYOFFICE_BROKER_ENABLED", "1")
        .arg("--enable")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(78));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        "DOCUMENT_BROKER_DISABLED: no production listener or execution backend"
    );
}

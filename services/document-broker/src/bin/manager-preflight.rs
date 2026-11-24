//! Explicit diagnostic; the default broker remains disabled.
use dyoffice_document_broker::manager_diagnostic::inspect_system_manager;

#[tokio::main]
async fn main() {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    #[cfg(target_os = "linux")]
    if first.as_deref() == Some(std::ffi::OsStr::new("--container")) && args.next().is_none() {
        let mut reasons = dyoffice_document_broker::container_probe::prerequisites();
        if reasons.is_empty() && inspect_system_manager().await.is_err() {
            reasons.push("private systemd manager unavailable");
        }
        println!(
            "{}",
            serde_json::json!({
                "scope": "read-only-container-prerequisites",
                "reasons": reasons,
                "execution_available": false,
                "isolation_certified": false
            })
        );
        if !reasons.is_empty() {
            std::process::exit(2);
        }
        return;
    }
    if first.is_some() {
        eprintln!("Usage: manager-preflight [--container]");
        std::process::exit(64);
    }
    match inspect_system_manager().await {
        Ok(observation) => {
            println!(
                "{}",
                serde_json::to_string(&observation).expect("fixed serializable metadata")
            );
        }
        Err(reason) => {
            println!(
                "{}",
                serde_json::json!({
                    "scope": "read-only-system-manager-observation",
                    "status": "unavailable", "reason": reason, "execution_available": false
                })
            );
            std::process::exit(2);
        }
    }
}

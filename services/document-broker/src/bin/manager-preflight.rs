//! Explicit diagnostic; the default broker remains disabled.
use dyoffice_document_broker::manager_diagnostic::inspect_system_manager;

#[tokio::main]
async fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("Usage: manager-preflight (no arguments)");
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

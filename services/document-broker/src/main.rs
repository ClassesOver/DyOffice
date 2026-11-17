fn main() {
    eprintln!("DOCUMENT_BROKER_DISABLED: no production listener or execution backend");
    std::process::exit(78);
}

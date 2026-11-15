//! Fixed child launcher. Resource evidence comes from the live cgroup, not child logs.
use std::{fs, io::Read, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicUsize, Ordering}}, thread, time::Duration};
use std::os::unix::process::ExitStatusExt;

fn oom_kills() -> std::io::Result<u64> {
    let text = fs::read_to_string("/sys/fs/cgroup/memory.events")?;
    text.lines().find_map(|line| line.strip_prefix("oom_kill ").and_then(|n| n.parse().ok()))
        .ok_or_else(|| std::io::Error::other("Missing cgroup v2 counter"))
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let executable = match args.as_slice() {
        [_, mode] if mode == "xlsx" => "/usr/local/bin/xlsx-sidecar",
        [_, mode] if mode == "probe" => "/usr/local/bin/sandbox-probe",
        _ => std::process::exit(78),
    };
    let baseline = oom_kills().unwrap_or_else(|_| std::process::exit(78));
    let mut child = Command::new(executable).stdin(Stdio::inherit()).stdout(Stdio::inherit())
        .stderr(Stdio::piped()).spawn().unwrap_or_else(|_| std::process::exit(78));
    // Unprivileged processes may raise their OOM score. Prefer the large native
    // child as victim so this small supervisor can collect kernel evidence.
    if fs::write(format!("/proc/{}/oom_score_adj", child.id()), b"1000").is_err() {
        let _ = child.kill(); let _ = child.wait(); std::process::exit(78);
    }
    let stderr_bytes = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&stderr_bytes);
    let mut stderr = child.stderr.take().unwrap();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        while let Ok(size) = stderr.read(&mut buffer) {
            if size == 0 { break; }
            count.fetch_add(size, Ordering::Relaxed);
        }
    });
    let mut stderr_limited = false;
    let status = loop {
        if stderr_bytes.load(Ordering::Relaxed) > 65536 && !stderr_limited {
            stderr_limited = true; let _ = child.kill();
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(_) => { let _ = child.kill(); let _ = child.wait(); std::process::exit(78); }
        }
    };
    let oom = oom_kills().map(|n| n > baseline).unwrap_or_else(|_| std::process::exit(78));
    let code = status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
    eprintln!("DYOFFICE_SANDBOX_STATUS={{\"oomKilled\":{},\"stderrLimited\":{},\"exitCode\":{}}}", oom, stderr_limited, code);
    std::process::exit(if stderr_limited { 90 } else { code });
}

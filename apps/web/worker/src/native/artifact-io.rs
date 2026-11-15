//! Linux-only fixed-path transport into a private job tmpfs. No workbook parsing.
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
const MAX: u64 = 32 * 1024 * 1024;
const NOFOLLOW_NONBLOCK: i32 = 0x20000 | 0x800; // Linux O_NOFOLLOW | O_NONBLOCK
fn transfer() -> io::Result<()> {
    match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [mode] if mode == "put" => {
            let mut target = OpenOptions::new().write(true).create_new(true).mode(0o400)
                .custom_flags(NOFOLLOW_NONBLOCK).open("/work/input.xlsx")?;
            let size = io::copy(&mut io::stdin().lock().take(MAX + 1), &mut target)?;
            if size == 0 || size > MAX {
                drop(target); let _ = fs::remove_file("/work/input.xlsx");
                return Err(io::Error::new(io::ErrorKind::InvalidData, "input size"));
            }
            target.sync_all()?;
        }
        [mode] if mode == "get" => {
            let source = OpenOptions::new().read(true).custom_flags(NOFOLLOW_NONBLOCK)
                .open("/work/output.xlsx")?;
            let metadata = source.metadata()?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "output size or type"));
            }
            let size = io::copy(&mut source.take(metadata.len() + 1), &mut io::stdout().lock())?;
            if size != metadata.len() { return Err(io::Error::new(io::ErrorKind::InvalidData, "output changed")); }
        }
        _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "mode")),
    }
    Ok(())
}
fn main() {
    if transfer().is_err() { eprintln!("artifact transfer failed"); std::process::exit(1); }
}

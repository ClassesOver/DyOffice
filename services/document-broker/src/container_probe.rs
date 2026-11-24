//! Test-only Ubuntu/Docker preflight. Never a runtime admission certificate.
#[derive(Clone)]
struct Facts {
    ubuntu: bool,
    docker_marker: bool,
    pid1_systemd: bool,
    private_root: bool,
    cgroup_rw: bool,
    controllers: String,
    mapped_root: bool,
    seccomp: bool,
    local_bus: bool,
    docker_socket: bool,
    opt_in: bool,
}
fn validate(f: &Facts) -> Result<(), &'static str> {
    for (ok, reason) in [
        (f.opt_in, "explicit diagnostic opt-in missing"),
        (f.ubuntu, "Ubuntu 24.04 required"),
        (f.docker_marker, "Docker markers missing"),
        (f.pid1_systemd, "systemd must be PID 1"),
        (f.private_root, "private cgroup v2 root required"),
        (f.cgroup_rw, "writable delegated cgroup v2 required"),
        (f.mapped_root, "root must map to nonzero host UID"),
        (f.seccomp, "seccomp filter required"),
        (f.local_bus, "local bus socket missing"),
        (!f.docker_socket, "Docker control socket exposed"),
    ] {
        if !ok {
            return Err(reason);
        }
    }
    if !["cpu", "memory", "pids"]
        .iter()
        .all(|v| f.controllers.split_whitespace().any(|c| c == *v))
    {
        return Err("required controllers missing");
    }
    Ok(())
}
pub(crate) fn preflight() -> Result<(), &'static str> {
    use std::{fs, os::unix::fs::FileTypeExt};
    let read = |p| fs::read_to_string(p).unwrap_or_default();
    let os = read("/etc/os-release");
    let env = fs::read("/proc/1/environ").unwrap_or_default();
    let mount = read("/proc/self/mountinfo");
    let cg = mount.lines().any(|line| {
        let f: Vec<_> = line.split_whitespace().collect();
        f.len() > 9
            && f[3] == "/"
            && f[4] == "/sys/fs/cgroup"
            && f[5].split(',').any(|x| x == "rw")
            && line.contains(" - cgroup2 ")
    });
    let socket = |p| {
        fs::symlink_metadata(p)
            .map(|m| m.file_type().is_socket())
            .unwrap_or(false)
    };
    validate(&Facts {
        ubuntu: os.lines().any(|v| v == "ID=ubuntu" || v == "ID=\"ubuntu\"")
            && os.lines().any(|v| v == "VERSION_ID=\"24.04\""),
        docker_marker: fs::symlink_metadata("/.dockerenv")
            .map(|m| m.file_type().is_file())
            .unwrap_or(false)
            && env.split(|b| *b == 0).any(|v| v == b"container=docker"),
        pid1_systemd: read("/proc/1/comm").trim() == "systemd",
        private_root: read("/proc/1/cgroup").trim() == "0::/",
        cgroup_rw: cg,
        controllers: read("/sys/fs/cgroup/cgroup.controllers"),
        mapped_root: unprivileged_map(&read("/proc/self/uid_map"))
            && unprivileged_map(&read("/proc/self/gid_map")),
        seccomp: read("/proc/self/status")
            .lines()
            .any(|v| v.split_whitespace().collect::<Vec<_>>() == ["Seccomp:", "2"]),
        local_bus: socket("/run/dbus/system_bus_socket"),
        docker_socket: !definitely_absent(fs::symlink_metadata("/run/docker.sock"))
            || !definitely_absent(fs::symlink_metadata("/var/run/docker.sock")),
        opt_in: std::env::var("DYOFFICE_CONTAINER_PROBE").as_deref()
            == Ok("ubuntu-docker-benign-only"),
    })
}
#[test]
fn complete_fixture_is_only_a_preflight_match() {
    assert_eq!(validate(&good()), Ok(()));
}
fn good() -> Facts {
    Facts {
        ubuntu: true,
        docker_marker: true,
        pid1_systemd: true,
        private_root: true,
        cgroup_rw: true,
        controllers: "cpu memory pids".into(),
        mapped_root: true,
        seccomp: true,
        local_bus: true,
        docker_socket: false,
        opt_in: true,
    }
}
#[test]
fn every_required_gate_fails_closed() {
    for key in 0..11 {
        let mut f = good();
        match key {
            0 => f.ubuntu = false,
            1 => f.docker_marker = false,
            2 => f.pid1_systemd = false,
            3 => f.private_root = false,
            4 => f.cgroup_rw = false,
            5 => f.controllers = "cpu memory".into(),
            6 => f.mapped_root = false,
            7 => f.seccomp = false,
            8 => f.local_bus = false,
            9 => f.docker_socket = true,
            _ => f.opt_in = false,
        };
        assert!(validate(&f).is_err(), "gate {key}");
    }
}

fn unprivileged_map(text: &str) -> bool {
    let mut intervals = Vec::new();
    for line in text.lines() {
        let Ok(v) = line
            .split_whitespace()
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
        else {
            return false;
        };
        if v.len() != 3 || v[1] == 0 || v[2] == 0 || v[1].checked_add(v[2]).is_none() {
            return false;
        }
        let Some(end) = v[0].checked_add(v[2]) else {
            return false;
        };
        intervals.push((v[0], end));
    }
    intervals.sort_unstable();
    if !intervals.iter().any(|&(start, end)| start == 0 && end > 0) {
        return false;
    }
    // systemd DynamicUser allocates UIDs/GIDs from 61184 through 65519 inclusive.
    let mut next = 61184;
    for (start, end) in intervals {
        if end <= next {
            continue;
        }
        if start > next {
            return false;
        }
        next = end;
        if next >= 65520 {
            return true;
        }
    }
    false
}

#[test]
fn rejects_host_root_and_accepts_rootless_split_mapping() {
    assert!(!unprivileged_map("0 0 4294967295"));
    assert!(unprivileged_map("0 100000 65536"));
    assert!(unprivileged_map("0 1000 1\n1 100000 65536"));
    for bad in [
        "",
        "0 1000 1",
        "0 x 65536",
        "0 1000 0",
        "0 1000 1\n1 0 65536",
    ] {
        assert!(!unprivileged_map(bad));
    }
}

#[test]
fn dynamic_user_entire_range_must_be_contiguously_mapped() {
    assert!(unprivileged_map("0 1000 1\n61184 200000 4336"));
    assert!(unprivileged_map(
        "0 1000 1\n61184 200000 1000\n62184 300000 3336"
    ));
    for bad in [
        "0 1000 1\n61185 200000 4335",
        "0 1000 1\n61184 200000 4335",
        "0 1000 1\n61184 200000 1000\n62185 300000 3335",
        "0 1000 1\n65534 200000 1",
        "0 0 1\n61184 200000 4336",
    ] {
        assert!(!unprivileged_map(bad), "{bad}");
    }
}

fn definitely_absent(result: std::io::Result<std::fs::Metadata>) -> bool {
    matches!(result, Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
#[test]
fn socket_absence_rejects_symlinks_files_and_lookup_uncertainty() {
    use std::{
        fs,
        io::{Error, ErrorKind},
        os::unix::fs::symlink,
    };
    assert!(definitely_absent(Err(Error::from(ErrorKind::NotFound))));
    for kind in [
        ErrorKind::PermissionDenied,
        ErrorKind::Other,
        ErrorKind::InvalidInput,
    ] {
        assert!(!definitely_absent(Err(Error::from(kind))));
    }
    let dir = std::env::temp_dir().join(format!("dyoffice-socket-denial-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let path = dir.join("docker.sock");
    fs::write(&path, b"not a socket").unwrap();
    assert!(!definitely_absent(fs::symlink_metadata(&path)));
    fs::remove_file(&path).unwrap();
    symlink("missing-target", &path).unwrap();
    assert!(!definitely_absent(fs::symlink_metadata(&path)));
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&dir).unwrap();
}

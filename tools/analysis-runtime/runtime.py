#!/usr/bin/env python3
"""构建可搬运 wheelhouse，并从中严格离线安装分析环境。"""
import argparse
import email.parser
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import sysconfig
import zipfile


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent.parent


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(args, *, env=None):
    subprocess.run([str(arg) for arg in args], check=True, env=env)


def target():
    return {"python": f"{sys.version_info.major}.{sys.version_info.minor}",
            "platform": sysconfig.get_platform(), "machine": platform.machine()}


def require_python():
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("分析运行环境需要已安装的 Python 3.12")
    if os.name != "posix":
        raise SystemExit("当前构建脚本支持 Linux/macOS；Windows 需独立适配安装布局")


def build(output):
    require_python()
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("联网构建需要 uv；离线安装会使用随包携带的 uv")
    output.mkdir(parents=True, exist_ok=True)
    requirements = SOURCE / "requirements.lock"
    run([uv, "lock", "--project", SOURCE, "--check", "--python", sys.executable, "--no-cache"])
    exported = subprocess.check_output([uv, "export", "--project", str(SOURCE), "--frozen", "--no-dev",
                                        "--no-emit-project", "--format", "requirements-txt", "--no-header"], text=True)
    canonical = lambda value: "\n".join(line for line in value.splitlines() if line.strip() and not line.lstrip().startswith("#"))
    if canonical(exported) != canonical(requirements.read_text()):
        raise SystemExit("requirements.lock 与 uv.lock 不一致；请重新 uv export 后构建")
    # 每次锁更新使用独立目录，避免旧版本 wheel 混入新的发布包。
    wheels = output / ("wheelhouse-" + digest(requirements)[:12])
    wheels.mkdir(exist_ok=True)
    builder = output / "builder"
    run([uv, "venv", "--python", sys.executable, "--seed", "--allow-existing", "--no-cache", builder])
    # wheel 验证源包 hash。少数库（odfpy）只发 sdist，在联网构建机生成 wheel；
    # 目标机器仅安装下面记录了 hash 的 wheel，不执行构建后端。
    run([builder / "bin/python", "-m", "pip", "wheel", "--disable-pip-version-check",
         "--require-hashes", "--no-deps", "--no-cache-dir", "--wheel-dir", wheels, "-r", requirements])
    artifacts = []
    lines = ["# 本平台离线 wheel 锁，来源为 requirements.lock 固定的发行包。"]
    for path in sorted(wheels.glob("*.whl")):
        with zipfile.ZipFile(path) as archive:
            metadata = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
            if len(metadata) != 1:
                raise SystemExit("无效 wheel 元数据")
            package = email.parser.Parser().parsestr(archive.read(metadata[0]).decode())
        sha256 = digest(path)
        artifacts.append({"file": path.name, "sha256": sha256, "size": path.stat().st_size,
                          "name": package["Name"], "version": package["Version"]})
        lines.append(f"{package['Name']}=={package['Version']} --hash=sha256:{sha256}")
    if not artifacts:
        raise SystemExit("没有构建 wheel")
    lock = output / "wheelhouse.lock"
    lock.write_text("\n".join(lines) + "\n")
    bundled_uv = output / "uv"
    shutil.copy2(uv, bundled_uv)
    bundled_uv.chmod(0o755)
    manifest = {"version": 1, "target": target(), "requirementsSha256": digest(requirements),
                "wheelDirectory": wheels.name, "lockSha256": digest(lock),
                "uvSha256": digest(bundled_uv), "wheels": artifacts}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"已构建 {len(artifacts)} 个 wheel：{output}")


def checked_bundle(output):
    require_python()
    manifest = json.loads((output / "manifest.json").read_text())
    if manifest.get("version") != 1 or manifest.get("target") != target():
        raise SystemExit("离线包平台或 Python 版本不匹配；需为目标平台重新构建")
    if manifest.get("requirementsSha256") != digest(SOURCE / "requirements.lock"):
        raise SystemExit("离线包与当前仓库的依赖锁不匹配；需使用同一发布版本")
    directory = manifest["wheelDirectory"]
    if Path(directory).name != directory or not directory.startswith("wheelhouse-"):
        raise SystemExit("无效 wheel 目录")
    wheels = output / directory
    if {path.name for path in wheels.iterdir()} != {item["file"] for item in manifest["wheels"]}:
        raise SystemExit("wheelhouse 存在缺失或额外文件")
    for item in manifest["wheels"]:
        name = item["file"]
        if Path(name).name != name or not name.endswith(".whl"):
            raise SystemExit("无效 wheel 文件名")
        path = wheels / name
        if path.is_symlink() or path.stat().st_size != item["size"] or digest(path) != item["sha256"]:
            raise SystemExit("wheel 校验失败：" + name)
    for filename, key in [("uv", "uvSha256"), ("wheelhouse.lock", "lockSha256")]:
        if digest(output / filename) != manifest[key]:
            raise SystemExit("离线安装工具或锁文件校验失败：" + filename)
    return manifest, wheels


def offline_environment(output):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    env.update({"UV_OFFLINE": "1", "UV_PYTHON_DOWNLOADS": "never", "PIP_NO_INDEX": "1",
                "PYTHONNOUSERSITE": "1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
                "PIP_DISABLE_PIP_VERSION_CHECK": "1", "MPLBACKEND": "Agg",
                "MPLCONFIGDIR": str(output / "matplotlib-cache"),
                "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
                "POLARS_MAX_THREADS": "2",
                "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": ""})
    return env


def install(output):
    _, wheels = checked_bundle(output)
    uv = output / "uv"
    env = offline_environment(output)
    runtime = output / "runtime"
    run([uv, "venv", "--offline", "--no-cache", "--python", sys.executable, "--allow-existing", runtime], env=env)
    run([uv, "pip", "sync", "--offline", "--no-index", "--no-cache", "--require-hashes",
         "--find-links", wheels, "--python", runtime / "bin/python", output / "wheelhouse.lock"], env=env)
    print(f"离线环境已安装：{runtime / 'bin/python'}")


def verify(output):
    manifest, _ = checked_bundle(output)
    run([output / "uv", "pip", "check", "--python", output / "runtime/bin/python"],
        env=offline_environment(output))
    run([output / "runtime/bin/python", "-m", "pytest", SOURCE / "tests", "-q", "-p", "no:cacheprovider"],
        env=offline_environment(output))
    print(json.dumps({"verified": True, "target": manifest["target"], "packages": len(manifest["wheels"]),
                      "python": str(output / "runtime/bin/python")}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "install", "verify"])
    parser.add_argument("--output", type=Path, default=ROOT / ".dyoffice-analysis-build")
    args = parser.parse_args()
    {"build": build, "install": install, "verify": verify}[args.command](args.output.resolve())


if __name__ == "__main__":
    main()

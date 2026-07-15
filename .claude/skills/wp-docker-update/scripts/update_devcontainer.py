#!/usr/bin/env python3
"""
既存プロジェクトの .devcontainer/ を、現在の wp-docker-setup テンプレと突き合わせて
「足りない機能」を検出し、安全な範囲だけを更新する。

設計方針:
- テンプレ実体も wp-docker-setup スキルも書き換えない
- 「今のテンプレでの理想形」は wp-docker-setup の render_template_files() を
  そのまま呼んで得る（生成内容の定義を二重に持たない）
- 既定は dry-run。--apply を明示したときだけ書き込む
- 書き込み前に .devcontainer/ をまるごとバックアップする
- 利用者が手で直した、または削除したファイル（マニフェスト記録と実物が
  一致しない）は --apply でも触らない。--force-conflict でパスを明示した
  ファイルだけを上書きする
- .devcontainer/ の外は .gitattributes にしか触らない。wp-config.php は一切触らない
  （DB値・接頭子の同期は setup-wp-config スキルの責務）
- 削除は一切行わない。テンプレに無いファイルは extra として報告するだけ
"""

from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

MANIFEST_NAME = ".wp-docker-setup.json"

# 更新対象から常に外す。certs/ は init-certs.sh が作る生成物。
SKIP_PREFIXES = ("certs/",)

DEFAULT_DIFF_LINES = 160

# render_template_files() が受け取るパラメータと既定値。
# マニフェストに無いキー・null は既定値で補い、未知のキーは捨てる。
RENDER_PARAM_DEFAULTS: dict[str, object] = {
    "project_name": None,
    "wp_root": "wordpress",
    "wp_content": "wp-content",
    "wp_table_prefix": "wp_",
    "mysql_version": None,
    "php_version": None,
    "wp_version": None,
    "node_version": None,
}


class UpdateError(Exception):
    pass


# ---------- wp-docker-setup スキルの探索・読み込み ----------

def resolve_setup_skill_dir(project_root: Path, override: str | None) -> Path:
    if override:
        candidates = [Path(override)]
    else:
        candidates = [
            # 兄弟スキル（.claude/skills/wp-docker-setup/）
            Path(__file__).resolve().parent.parent.parent / "wp-docker-setup",
            project_root / ".claude" / "skills" / "wp-docker-setup",
        ]

    for candidate in candidates:
        if (candidate / "scripts" / "install_devcontainer.py").is_file():
            return candidate.resolve()

    listed = "\n".join(f"- {c}" for c in candidates)
    raise UpdateError(
        "wp-docker-setup スキルが見つかりません。最新版をプロジェクトに配置してから"
        "実行してください。探索した場所:\n" + listed
    )


def load_install_module(setup_skill_dir: Path):
    path = setup_skill_dir / "scripts" / "install_devcontainer.py"
    spec = importlib.util.spec_from_file_location("wp_docker_setup_install", path)
    if spec is None or spec.loader is None:
        raise UpdateError(f"install_devcontainer.py を読み込めません: {path}")
    module = importlib.util.module_from_spec(spec)

    # import の副作用で利用者のスキルディレクトリに __pycache__ を作らない
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous

    # 書き込みを始めてから足りないと分かると、ファイルだけ新しくマニフェストが古い
    # 不整合が残る。このスキルが使う API はすべてここで先に検査する。
    for required in (
        "render_template_files",
        "sha256_bytes",
        "read_skill_version",
        "write_manifest",
        "ensure_shell_lf_gitattributes",
    ):
        if not hasattr(module, required):
            raise UpdateError(
                f"wp-docker-setup スキルにこのスキルが必要とする {required}() がありません: {path}\n"
                "wp-docker-setup を 1.8.0 以降に更新してください。"
            )
    return module


def resolve_template_dir(
    setup_skill_dir: Path, project_root: Path, template_type: str, override: str | None
) -> Path:
    name = f".devcontainer-{template_type}"
    if override:
        candidates = [Path(override)]
    else:
        candidates = [
            setup_skill_dir / "templates" / name,
            project_root / ".claude" / "skills" / "wp-docker-setup" / "templates" / name,
            project_root / name,
        ]

    for candidate in candidates:
        if candidate.is_dir():
            return candidate.resolve()

    listed = "\n".join(f"- {c}" for c in candidates)
    raise UpdateError(f"テンプレ {name} が見つかりません。探索した場所:\n{listed}")


# ---------- マニフェスト ----------

def read_manifest(dest: Path) -> dict | None:
    path = dest / MANIFEST_NAME
    if not path.is_file():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise UpdateError(f"マニフェストが壊れています: {path}: {e}")

    if not isinstance(data, dict) or not isinstance(data.get("files"), dict):
        raise UpdateError(f"マニフェストの形式が想定と異なります: {path}")

    return data


def normalize_params(raw: dict) -> dict:
    params = dict(RENDER_PARAM_DEFAULTS)
    for key in RENDER_PARAM_DEFAULTS:
        value = raw.get(key)
        if value is not None:
            params[key] = value
    return params


# ---------- レガシー（マニフェスト無し）からのパラメータ逆算 ----------

def _read_text(path: Path) -> str | None:
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def detect_template_type(dest: Path) -> str:
    if (dest / "Dockerfile.php").is_file():
        return "wp"
    if (dest / "Dockerfile.frontend").is_file():
        return "node"
    raise UpdateError(
        "Dockerfile.php / Dockerfile.frontend のどちらも無く、テンプレ種別を判別できません。"
        "--type wp|node で明示してください。"
    )


def read_actual_versions(dest: Path, template_type: str) -> dict[str, str]:
    """実際に動いている .devcontainer/ から PHP / WP / MySQL / Node のバージョンを読む。

    ここで読めた値が「その案件の現状」。テンプレ既定値で上書きしてはいけない対象。
    """
    found: dict[str, str] = {}

    if template_type == "node":
        text = _read_text(dest / "Dockerfile.frontend") or ""
        m = re.search(r"^FROM\s+node:(\S+)", text, flags=re.MULTILINE)
        if m:
            found["node_version"] = m.group(1)
        return found

    compose = _read_text(dest / "docker-compose.yml") or ""
    m = re.search(r"image:\s*mysql:(\S+)", compose)
    if m:
        found["mysql_version"] = m.group(1)

    dockerfile = _read_text(dest / "Dockerfile.php") or ""
    m = re.search(r"^FROM\s+php:(\S+?)-fpm", dockerfile, flags=re.MULTILINE)
    if m:
        found["php_version"] = m.group(1)
    m = re.search(r"^ENV\s+WORDPRESS_VERSION=(\S+)", dockerfile, flags=re.MULTILINE)
    if m:
        found["wp_version"] = m.group(1)

    return found


def pin_missing_versions(
    dest: Path, template_type: str, params: dict
) -> tuple[dict, list[str]]:
    """バージョンが未確定なら実物から読んで固定する。

    未確定のまま理想形を組むとテンプレ既定値が採用され、実物との差が outdated
    （＝利用者が触っていない＝自動更新してよい）に分類されてしまう。その結果
    PHP や MySQL が無警告で上がる。実物を正としてここで塞ぐ。
    """
    pinned = dict(params)
    notes: list[str] = []
    actual = read_actual_versions(dest, template_type)

    for key, (label, _flag) in VERSION_LABELS.items():
        if pinned.get(key):
            continue
        if key in actual:
            pinned[key] = actual[key]
            notes.append(
                f"{label} のバージョン記録が無かったため、実物から読み取った "
                f"{actual[key]} に固定しました（テンプレ既定への自動更新を防ぐため）。"
            )

    return pinned, notes


def infer_params(dest: Path, project_root: Path, template_type: str) -> tuple[dict, list[str]]:
    """既存の .devcontainer/ から生成パラメータを逆算する。

    ここで復元した値は「その案件の現状」であって「テンプレの既定値」ではない。
    PHP/MySQL/WP のバージョンを本番に合わせている案件を、テンプレ既定値で
    勝手に上書きしないために必ず現状値を拾う。
    """
    notes: list[str] = []
    params = dict(RENDER_PARAM_DEFAULTS)

    devcontainer_json = _read_text(dest / "devcontainer.json")
    if devcontainer_json:
        m = re.search(r'"name"\s*:\s*"([^"]+)"', devcontainer_json)
        if m:
            params["project_name"] = m.group(1)
    if not params["project_name"]:
        params["project_name"] = project_root.name
        notes.append(
            f'devcontainer.json から name を読めなかったため、ディレクトリ名 "{project_root.name}" を仮定しました。'
        )

    params.update(read_actual_versions(dest, template_type))

    if template_type == "node":
        if not params["node_version"]:
            notes.append(
                "Dockerfile.frontend から Node バージョンを読めませんでした。"
                "--node-version で明示しないとテンプレ既定値に更新される恐れがあります。"
            )
        return params, notes

    compose = _read_text(dest / "docker-compose.yml")
    if not compose:
        notes.append("docker-compose.yml が読めず、WP 関連の値をすべて既定値で仮定しました。")
        return params, notes

    # wp_root / wp_content
    # 現行テンプレの x-wp-content アンカー形式と、旧テンプレのサービス直下記述の両方に当たる
    m = re.search(r"\.\./([^/\s]+)/([^:\s]+):/var/www/html/([^/\s]+)/wp-content", compose)
    if m:
        params["wp_root"] = m.group(3)
        params["wp_content"] = m.group(2)
    else:
        for pattern in (
            r"/var/www/html/([^/\s:]+)/wp-config\.php",
            r"wp_core:/var/www/html/([^/\s:]+)",
        ):
            m2 = re.search(pattern, compose)
            if m2:
                params["wp_root"] = m2.group(1)
                break
        else:
            notes.append("WP ルート名を compose から特定できず、既定の 'wordpress' を仮定しました。")
        notes.append(
            f"wp-content のマウント記述を検出できず、既定の 'wp-content' を仮定しました。"
        )

    if not (project_root / str(params["wp_root"]) / "wp-config.php").is_file():
        notes.append(
            f"逆算した WP ルート '{params['wp_root']}' に wp-config.php が見つかりません。"
            "値が正しいかユーザーに確認してください。"
        )

    # テーブル接頭子
    m = re.search(
        r"^\s*WORDPRESS_TABLE_PREFIX\s*:\s*(.+?)\s*(?:#.*)?$", compose, flags=re.MULTILINE
    )
    if m:
        params["wp_table_prefix"] = m.group(1).strip().strip("\"'")
    else:
        wp_config = _read_text(project_root / str(params["wp_root"]) / "wp-config.php")
        m2 = (
            re.search(r"^\s*\$table_prefix\s*=\s*'([^']*)';", wp_config, flags=re.MULTILINE)
            if wp_config
            else None
        )
        if m2:
            params["wp_table_prefix"] = m2.group(1)
            notes.append(
                f"compose に WORDPRESS_TABLE_PREFIX が無いため、既存 wp-config.php の "
                f"'{m2.group(1)}' を採用しました。"
            )
        else:
            notes.append("テーブル接頭子を特定できず、既定の 'wp_' を仮定しました。")

    return params, notes


def template_default_versions(template_dir: Path, template_type: str) -> dict[str, str]:
    """テンプレ側の既定バージョン。案件の現状値と比べて情報提示するためだけに使う。"""
    defaults: dict[str, str] = {}

    if template_type == "node":
        text = _read_text(template_dir / "Dockerfile.frontend") or ""
        m = re.search(r"^FROM\s+node:(\S+)", text, flags=re.MULTILINE)
        if m:
            defaults["node_version"] = m.group(1)
        return defaults

    compose = _read_text(template_dir / "docker-compose.yml") or ""
    m = re.search(r"image:\s*mysql:(\S+)", compose)
    if m:
        defaults["mysql_version"] = m.group(1)

    dockerfile = _read_text(template_dir / "Dockerfile.php") or ""
    m = re.search(r"^FROM\s+php:(\S+?)-fpm", dockerfile, flags=re.MULTILINE)
    if m:
        defaults["php_version"] = m.group(1)
    m = re.search(r"^ENV\s+WORDPRESS_VERSION=(\S+)", dockerfile, flags=re.MULTILINE)
    if m:
        defaults["wp_version"] = m.group(1)

    return defaults


VERSION_LABELS = {
    "php_version": ("PHP", "--php-version"),
    "wp_version": ("WordPress", "--wp-version"),
    "mysql_version": ("MySQL", "--mysql-version"),
    "node_version": ("Node.js", "--node-version"),
}


def version_notes(params: dict, defaults: dict[str, str]) -> list[str]:
    """案件のバージョンとテンプレ既定のズレを知らせる。

    値が特定できていない（None）ときは黙ってはいけない。その状態で理想形を組むと
    テンプレ既定値が採用され、実物との差が outdated（＝自動更新可）に分類されて
    PHP や MySQL が無警告で上がってしまうため。
    """
    notes: list[str] = []
    for key, (label, flag) in VERSION_LABELS.items():
        current = params.get(key)
        latest = defaults.get(key)
        if not latest:
            continue
        if not current:
            notes.append(
                f"[要確認] {label}: この案件の値を特定できませんでした。このまま更新すると"
                f"テンプレ既定の {latest} に変わる可能性があります。実際の値を確認し "
                f"{flag} で明示してください。"
            )
        elif current != latest:
            notes.append(
                f"{label}: この案件は {current} / テンプレ既定は {latest}。"
                "本番環境に合わせている可能性があるため自動では変更しません。"
                "上げる場合は wp-docker-setup 側で明示してください。"
            )
    return notes


# ---------- 差分の分類 ----------

def _is_skipped(relpath: str) -> bool:
    if relpath == MANIFEST_NAME:
        return True
    return relpath.startswith(SKIP_PREFIXES)


def classify(
    dest: Path, ideal: dict[str, bytes], baseline: dict[str, str], sha256_bytes
) -> dict[str, list[str]]:
    """理想形と実物を突き合わせて4分類する。

    outdated（＝実物のハッシュがマニフェスト記録と一致）だけが「利用者が触っていない」
    と言い切れる。それ以外の差分は conflict として人間の判断に回す。
    """
    added: list[str] = []
    unchanged: list[str] = []
    outdated: list[str] = []
    conflict: list[str] = []

    for relpath, data in sorted(ideal.items()):
        if _is_skipped(relpath):
            continue

        actual_path = dest / relpath
        if not actual_path.is_file():
            # マニフェストに記録済みなら、生成後に利用者が意図的に削除した可能性がある。
            # 新規テンプレファイルだけを added とし、削除済み生成物は conflict に回す。
            if relpath in baseline:
                conflict.append(relpath)
            else:
                added.append(relpath)
            continue

        actual = actual_path.read_bytes()
        if actual == data:
            unchanged.append(relpath)
            continue

        recorded = baseline.get(relpath)
        if recorded and sha256_bytes(actual) == recorded:
            outdated.append(relpath)
        else:
            conflict.append(relpath)

    ideal_paths = set(ideal)
    extra: list[str] = []
    for path in sorted(dest.rglob("*")):
        if path.is_dir():
            continue
        relpath = path.relative_to(dest).as_posix()
        if _is_skipped(relpath) or relpath in ideal_paths:
            continue
        extra.append(relpath)

    return {
        "added": added,
        "outdated": outdated,
        "conflict": conflict,
        "unchanged": unchanged,
        "extra": extra,
    }


def make_diff(relpath: str, actual: bytes, ideal: bytes, max_lines: int) -> str:
    try:
        before = actual.decode("utf-8").splitlines()
        after = ideal.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        return "(バイナリファイルのため差分表示を省略)"

    lines = list(
        difflib.unified_diff(
            before,
            after,
            fromfile=f"現状/{relpath}",
            tofile=f"最新テンプレ/{relpath}",
            lineterm="",
        )
    )
    if len(lines) > max_lines:
        omitted = len(lines) - max_lines
        lines = lines[:max_lines] + [f"... (差分が長いため残り {omitted} 行を省略)"]
    return "\n".join(lines)


# ---------- 機能チェックリスト ----------

class Ctx:
    def __init__(self, dest: Path, project_root: Path):
        self.dest = dest
        self.project_root = project_root

    def text(self, relpath: str) -> str | None:
        return _read_text(self.dest / relpath)

    def exists(self, relpath: str) -> bool:
        return (self.dest / relpath).is_file()


def _collect_port_entries(compose_text: str) -> list[str]:
    """compose の ports: ブロック配下の項目だけを拾う。"""
    entries: list[str] = []
    in_ports = False
    ports_indent = 0

    for line in compose_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())

        if stripped == "ports:":
            in_ports = True
            ports_indent = indent
            continue

        if in_ports:
            if stripped.startswith("- ") and indent > ports_indent:
                entries.append(stripped[2:].strip().strip("\"'"))
            else:
                in_ports = False

    return entries


def _check_initialize_command(ctx: Ctx):
    text = ctx.text("devcontainer.json")
    if text is None:
        return "unknown", "devcontainer.json が読めない"
    if '"initializeCommand"' in text and "pre-rebuild-cleanup" in text:
        return "ok", "リビルド前に古い Compose コンテナを掃除する"
    return "missing", "リビルド時に 3306 等のポート競合で落ちる可能性がある"


def _check_cleanup_scripts(ctx: Ctx):
    have_sh = ctx.exists("scripts/pre-rebuild-cleanup.sh")
    have_ps1 = ctx.exists("scripts/pre-rebuild-cleanup.ps1")
    if have_sh and have_ps1:
        return "ok", "sh / ps1 の両方がある"
    missing = [
        name
        for name, ok in (("pre-rebuild-cleanup.sh", have_sh), ("pre-rebuild-cleanup.ps1", have_ps1))
        if not ok
    ]
    return "missing", "不足: " + ", ".join(missing)


def _check_cleanup_scoped(ctx: Ctx):
    text = ctx.text("scripts/pre-rebuild-cleanup.sh")
    if text is None:
        return "unknown", "pre-rebuild-cleanup.sh が無い"
    if "com.docker.compose.project.working_dir" in text:
        return "ok", "現在のワークスペースのリソースだけを削除する"
    return (
        "missing",
        "作業ディレクトリを確認せず削除するため、別プロジェクトのコンテナを巻き込む恐れがある",
    )


def _check_init_wp_config_script(ctx: Ctx):
    compose = ctx.text("docker-compose.yml")
    if not ctx.exists("scripts/init-wp-config.sh"):
        return "missing", "旧方式（compose 内インライン sed）のままの可能性が高い"
    if compose and "init-wp-config.sh" in compose:
        return "ok", "php サービスが init-wp-config.sh 経由で起動する"
    return "missing", "init-wp-config.sh はあるが compose から呼ばれていない"


def _check_wp_config_preserved(ctx: Ctx):
    text = ctx.text("scripts/init-wp-config.sh")
    if text is None:
        compose = ctx.text("docker-compose.yml") or ""
        if "sed -i" in compose and "wp-config.php" in compose:
            return "missing", "compose 内の sed が既存 wp-config.php を書き換える旧方式"
        return "unknown", "init-wp-config.sh が無く方式を判別できない"
    if "sed -i" in text and "wp-config.php" in text:
        return "missing", "init-wp-config.sh が既存 wp-config.php を sed で書き換える"
    if re.search(r'if\s+\[\s+!\s+-f\s+"\$WP_CONFIG"\s+\]', text):
        return "ok", "wp-config.php が無いときだけ作成し、既存は変更しない"
    return "unknown", "既存 wp-config.php を保護するガードを確認できない"


def _check_localhost_ports(ctx: Ctx):
    compose = ctx.text("docker-compose.yml")
    if compose is None:
        return "unknown", "docker-compose.yml が読めない"

    entries = _collect_port_entries(compose)
    if not entries:
        return "unknown", "ports の記述を検出できない"

    exposed = [e for e in entries if not e.startswith("127.0.0.1:")]
    if exposed:
        return "missing", "LAN に公開されているポート: " + ", ".join(exposed)
    return "ok", f"{len(entries)} 個のポートすべてが 127.0.0.1 に限定されている"


def _check_wp_content_anchor(ctx: Ctx):
    compose = ctx.text("docker-compose.yml")
    if compose is None:
        return "unknown", "docker-compose.yml が読めない"
    if re.search(r"^x-wp-content:\s*&wp_content\s", compose, flags=re.MULTILINE):
        return "ok", "wp-content のマウントをアンカーで一元管理している"
    return "missing", "wp-content フォルダ名がカスタムの場合にマウント漏れが起きやすい"


def _check_uploads_ini(ctx: Ctx):
    compose = ctx.text("docker-compose.yml") or ""
    if ctx.exists("php/uploads.ini") and "uploads.ini" in compose:
        return "ok", "アップロード上限等の PHP 設定が効いている"
    return "missing", "php/uploads.ini が無く、アップロード上限がデフォルトのまま"


def _check_readme(ctx: Ctx):
    if ctx.exists("README.md"):
        return "ok", "アクセス先 URL の案内がある"
    return "missing", "起動後のアクセス URL 案内が無い"


def _check_shell_lf(ctx: Ctx):
    scripts = sorted(ctx.dest.rglob("*.sh"))
    if not scripts:
        return "unknown", ".sh ファイルが無い"
    crlf = [
        p.relative_to(ctx.dest).as_posix() for p in scripts if b"\r\n" in p.read_bytes()
    ]
    if crlf:
        return "missing", "CRLF になっている（コンテナが起動失敗する）: " + ", ".join(crlf)
    return "ok", f"{len(scripts)} 個の .sh がすべて LF"


def _check_gitattributes(ctx: Ctx):
    path = ctx.project_root / ".gitattributes"
    if not path.is_file():
        return "missing", ".gitattributes が無く、clone 時に .sh が CRLF 化する恐れがある"
    lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8", errors="replace")
        .replace("\r\n", "\n")
        .split("\n")
    ]
    if "*.sh text eol=lf" in lines:
        return "ok", "*.sh text eol=lf がある"
    return "missing", "*.sh text eol=lf が無い"


def _check_no_placeholder(ctx: Ctx):
    hits: list[str] = []
    for path in sorted(ctx.dest.rglob("*")):
        if path.is_dir():
            continue
        relpath = path.relative_to(ctx.dest).as_posix()
        if _is_skipped(relpath):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for found in re.findall(r"\{\{[A-Z_]+\}\}", text):
            hits.append(f"{relpath}: {found}")

    if hits:
        return "missing", "未置換のプレースホルダが残っている: " + ", ".join(hits)
    return "ok", "未置換のプレースホルダは無い"


# (id, ラベル, 対象テンプレ種別, 判定関数)
FEATURE_CHECKS = [
    ("initialize-command", "リビルド前クリーンアップ (initializeCommand)", {"wp", "node"}, _check_initialize_command),
    ("cleanup-scripts", "pre-rebuild-cleanup スクリプト一式", {"wp", "node"}, _check_cleanup_scripts),
    ("cleanup-scoped", "クリーンアップ範囲を自ワークスペースに限定", {"wp", "node"}, _check_cleanup_scoped),
    ("init-wp-config", "init-wp-config.sh 方式", {"wp"}, _check_init_wp_config_script),
    ("wp-config-preserved", "既存 wp-config.php を書き換えない", {"wp"}, _check_wp_config_preserved),
    ("localhost-ports", "公開ポートを 127.0.0.1 に限定", {"wp"}, _check_localhost_ports),
    ("wp-content-anchor", "wp-content マウントのアンカー化", {"wp"}, _check_wp_content_anchor),
    ("uploads-ini", "php/uploads.ini", {"wp"}, _check_uploads_ini),
    ("readme-urls", "アクセス URL 案内 README", {"wp"}, _check_readme),
    ("shell-lf", ".sh が LF 改行", {"wp", "node"}, _check_shell_lf),
    ("gitattributes", ".gitattributes の *.sh text eol=lf", {"wp", "node"}, _check_gitattributes),
    ("no-placeholder", "プレースホルダ未置換なし", {"wp", "node"}, _check_no_placeholder),
]


def run_feature_checks(ctx: Ctx, template_type: str) -> list[dict]:
    results: list[dict] = []
    for check_id, label, types, fn in FEATURE_CHECKS:
        if template_type not in types:
            continue
        status, detail = fn(ctx)
        results.append({"id": check_id, "label": label, "status": status, "detail": detail})
    return results


# ---------- 適用 ----------

def make_backup(dest: Path, backup_dir: str | None) -> Path:
    """更新前の .devcontainer/ を丸ごと退避する。既存のバックアップは絶対に潰さない。"""
    if backup_dir:
        # 明示指定された場合は黙って別名にしない（利用者の指定を尊重する）
        target = Path(backup_dir)
        if target.exists():
            raise UpdateError(f"バックアップ先が既に存在します: {target}")
        if not target.parent.is_dir():
            raise UpdateError(
                f"バックアップ先の親ディレクトリがありません: {target.parent}\n"
                "相対パスはカレントディレクトリ基準で解決されます。絶対パスの指定を推奨します。"
            )
    else:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = dest.parent / f"{dest.name}.bak-{stamp}"
        target = base
        # 同じ秒に複数回実行しても、既存バックアップを上書きせず連番で逃がす
        for suffix in range(2, 100):
            if not target.exists():
                break
            target = base.with_name(f"{base.name}-{suffix}")
        else:
            raise UpdateError(
                f"バックアップ先が作れません（{base}-2 〜 -99 がすべて存在します）。"
                "古いバックアップを整理するか --backup-dir で指定してください。"
            )

    try:
        shutil.copytree(dest, target)
    except OSError as e:
        raise UpdateError(
            f"バックアップを作成できませんでした: {target}: {e}\n"
            "バックアップなしでは更新しません。書き込み権限と空き容量を確認してください。"
        )
    return target


def apply_changes(
    *,
    dest: Path,
    project_root: Path,
    ideal: dict[str, bytes],
    plan: dict[str, list[str]],
    template_type: str,
    params: dict,
    old_manifest: dict | None,
    selected_conflicts: list[str],
    backup_dir: str | None,
    install_mod,
) -> dict:
    backup = make_backup(dest, backup_dir)

    to_write = list(plan["added"]) + list(plan["outdated"])
    to_write += selected_conflicts

    written_so_far: list[str] = []
    try:
        for relpath in to_write:
            out_path = dest / relpath
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(ideal[relpath])
            written_so_far.append(relpath)
    except OSError as e:
        # 途中で失敗すると「ファイルは新しいがマニフェストは古い」不整合が残る。
        # 自動復元はせず、何がどこまで進んだかと復元手段を必ず示す。
        raise UpdateError(
            f"更新の途中で書き込みに失敗しました: {e}\n"
            f"書き込み済み: {written_so_far or '(なし)'}\n"
            f"未処理: {[p for p in to_write if p not in written_so_far]}\n"
            f"マニフェストは更新していません。元に戻すにはバックアップの中身を "
            f"{dest} へ戻してください: {backup}"
        )

    # マニフェストの files は「このスキルが生成した内容」の基準点。
    # 上書きしなかった conflict は旧基準を維持する。実物のハッシュを記録すると、
    # 次回実行時にその手編集を「テンプレ更新で変わっただけ」と誤認して潰してしまう。
    old_files = (old_manifest or {}).get("files", {})
    written = set(to_write)
    files: dict[str, str] = {}
    for relpath, data in sorted(ideal.items()):
        if _is_skipped(relpath):
            continue
        if relpath in written or relpath in plan["unchanged"]:
            files[relpath] = install_mod.sha256_bytes(data)
        elif relpath in old_files:
            files[relpath] = old_files[relpath]

    manifest = {
        "skill": "wp-docker-setup",
        "skill_version": install_mod.read_skill_version(),
        "template_type": template_type,
        "params": params,
        "files": files,
    }
    install_mod.write_manifest(dest, manifest)

    gitattributes = install_mod.ensure_shell_lf_gitattributes(project_root)

    return {
        "backup": str(backup),
        "written": sorted(written),
        "skipped_conflicts": [
            relpath for relpath in plan["conflict"] if relpath not in selected_conflicts
        ],
        "manifest": str(dest / MANIFEST_NAME),
        "updated_gitattributes": gitattributes,
    }


# ---------- CLI ----------

def main() -> int:
    # 出力は機械可読な JSON。コンソールのコードページ（Windows では cp932 等）に
    # 左右されないよう UTF-8 に固定する。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass

    p = argparse.ArgumentParser(
        description="既存 .devcontainer/ を現在の wp-docker-setup テンプレに合わせて更新する"
    )
    p.add_argument("--project-root", required=True, help="案件リポジトリのルート絶対パス")
    p.add_argument("--output", default=".devcontainer", help="更新対象ディレクトリ名")
    p.add_argument("--type", choices=["wp", "node"], default=None, help="テンプレ種別（省略時は自動判別）")
    p.add_argument("--setup-skill-dir", default=None, help="wp-docker-setup スキルディレクトリの明示指定")
    p.add_argument("--template-dir", default=None, help="テンプレディレクトリの明示指定")
    p.add_argument("--apply", action="store_true", help="実際に書き込む（既定は dry-run）")
    p.add_argument(
        "--adopt",
        action="store_true",
        help="マニフェスト未作成の既存環境に対し、逆算値をユーザー確認済みとしてマニフェストを作成する",
    )
    p.add_argument(
        "--force-conflict",
        action="append",
        default=[],
        metavar="PATH",
        help=(
            "指定した conflict ファイルだけをテンプレ内容で上書きする。"
            "複数指定可（--apply 必須）"
        ),
    )
    p.add_argument("--backup-dir", default=None, help="バックアップ先の明示指定")
    p.add_argument("--diff-lines", type=int, default=DEFAULT_DIFF_LINES, help="1ファイルあたりの差分表示行数上限")

    # 逆算値の上書き（ユーザー確認で誤りが判明した場合に使う）
    p.add_argument("--name", default=None)
    p.add_argument("--wp-root", default=None)
    p.add_argument("--wp-content", default=None)
    p.add_argument("--wp-table-prefix", default=None)
    p.add_argument("--php-version", default=None)
    p.add_argument("--wp-version", default=None)
    p.add_argument("--mysql-version", default=None)
    p.add_argument("--node-version", default=None)

    args = p.parse_args()

    if args.wp_table_prefix and not re.fullmatch(r"[A-Za-z0-9_]+", args.wp_table_prefix):
        print("ERROR: --wp-table-prefix は英数字とアンダースコアのみ使用できます。", file=sys.stderr)
        return 1

    if args.force_conflict and not args.apply:
        print("ERROR: --force-conflict は --apply と併用してください。", file=sys.stderr)
        return 1

    try:
        return _run(args)
    except UpdateError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


def _run(args) -> int:
    project_root = Path(args.project_root).resolve()
    if not project_root.is_dir():
        raise UpdateError(f"プロジェクトルートが見つかりません: {project_root}")

    dest = project_root / args.output
    if not dest.is_dir():
        raise UpdateError(
            f"更新対象が見つかりません: {dest}\n"
            "新規に構築する場合は wp-docker-setup スキル（Dockerセットアップ）を使ってください。"
        )

    setup_skill_dir = resolve_setup_skill_dir(project_root, args.setup_skill_dir)
    install_mod = load_install_module(setup_skill_dir)

    manifest = read_manifest(dest)
    inference_notes: list[str] = []

    if manifest is not None:
        mode = "manifest"
        template_type = args.type or manifest.get("template_type") or detect_template_type(dest)
        params = normalize_params(manifest.get("params") or {})
        baseline: dict[str, str] = manifest.get("files") or {}
        recorded_version = manifest.get("skill_version")
    else:
        mode = "legacy"
        template_type = args.type or detect_template_type(dest)
        params, inference_notes = infer_params(dest, project_root, template_type)
        baseline = {}
        recorded_version = None

    # CLI で明示された値は逆算値・マニフェスト値より優先する
    overrides = {
        "project_name": args.name,
        "wp_root": args.wp_root,
        "wp_content": args.wp_content,
        "wp_table_prefix": args.wp_table_prefix,
        "php_version": args.php_version,
        "wp_version": args.wp_version,
        "mysql_version": args.mysql_version,
        "node_version": args.node_version,
    }
    for key, value in overrides.items():
        if value is not None:
            params[key] = value

    # バージョンが未確定のまま残ると、理想形がテンプレ既定値で組まれ、その差が
    # outdated（自動更新可）に化けて PHP / MySQL を無警告で引き上げてしまう。
    # マニフェスト・逆算・CLI のどれでも埋まらなかった分を実物から固定する。
    params, pin_notes = pin_missing_versions(dest, template_type, params)
    inference_notes.extend(pin_notes)

    if not params.get("project_name"):
        raise UpdateError("プロジェクト名を決定できません。--name で指定してください。")

    template_dir = resolve_template_dir(setup_skill_dir, project_root, template_type, args.template_dir)

    try:
        ideal = install_mod.render_template_files(
            template_type=template_type,
            template_dir=template_dir,
            **params,
        )
    except Exception as e:  # TemplateMismatch 等
        raise UpdateError(
            f"最新テンプレの展開に失敗しました: {e}\n"
            "テンプレと install_devcontainer.py の置換ルールが噛み合っていない可能性があります。"
        )

    plan = classify(dest, ideal, baseline, install_mod.sha256_bytes)

    # conflict の一括上書きは許可しない。ユーザーが確認したパスだけを選ばせる。
    # CLI では Windows の区切りも受け付けるが、内部表現は manifest と同じ POSIX 形式に揃える。
    selected_conflicts = list(dict.fromkeys(path.replace("\\", "/") for path in args.force_conflict))
    unknown_conflicts = [path for path in selected_conflicts if path not in plan["conflict"]]
    if unknown_conflicts:
        available = ", ".join(plan["conflict"]) or "(なし)"
        raise UpdateError(
            "--force-conflict に現在 conflict ではないパスが指定されています: "
            + ", ".join(unknown_conflicts)
            + f"\n指定可能な conflict: {available}"
        )

    conflicts = []
    for relpath in plan["conflict"]:
        actual_path = dest / relpath
        actual = actual_path.read_bytes() if actual_path.is_file() else b""
        conflicts.append(
            {
                "path": relpath,
                "diff": make_diff(
                    relpath, actual, ideal[relpath], args.diff_lines
                ),
                "reason": "modified" if actual_path.is_file() else "deleted",
            }
        )

    ctx = Ctx(dest, project_root)
    features = run_feature_checks(ctx, template_type)
    defaults = template_default_versions(template_dir, template_type)

    result: dict = {
        "mode": mode,
        "template_type": template_type,
        "target": str(dest),
        "template": str(template_dir),
        "skill_version": {
            "current": install_mod.read_skill_version(),
            "recorded": recorded_version,
        },
        "params": params,
        "params_source": "manifest" if mode == "manifest" else "inferred",
        "inference_notes": inference_notes,
        "version_notes": version_notes(params, defaults),
        "files": {
            "added": plan["added"],
            "outdated": plan["outdated"],
            "conflict": conflicts,
            "unchanged": plan["unchanged"],
            "extra": plan["extra"],
        },
        "features": features,
        "applied": False,
    }

    if mode == "legacy":
        result.setdefault("warnings", []).append(
            "マニフェストが無いため、テンプレと異なるファイルはすべて conflict 扱いです。"
            "自動では既存ファイルを更新しません（新規ファイルの追加のみ）。"
        )

    if not args.apply:
        result["hint"] = (
            "dry-run です。書き込むには --apply を付けてください。"
            + ("（レガシー環境では --adopt も必要です）" if mode == "legacy" else "")
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if mode == "legacy" and not args.adopt:
        raise UpdateError(
            "マニフェストが無い既存環境です。逆算したパラメータをユーザーに提示して確認を取ったうえで、"
            "--adopt を付けて再実行してください（誤った値でマニフェストを作ると次回以降の判定が壊れます）。"
        )

    applied = apply_changes(
        dest=dest,
        project_root=project_root,
        ideal=ideal,
        plan=plan,
        template_type=template_type,
        params=params,
        old_manifest=manifest,
        selected_conflicts=selected_conflicts,
        backup_dir=args.backup_dir,
        install_mod=install_mod,
    )

    result["applied"] = True
    result["apply_result"] = applied
    # 適用前の診断結果を返すと、追加・更新に成功しても missing のままに見える。
    # ファイル更新と .gitattributes 追記が終わった実物を再診断して返す。
    result["features"] = run_feature_checks(Ctx(dest, project_root), template_type)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

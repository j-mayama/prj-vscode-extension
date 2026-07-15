#!/usr/bin/env python3
"""
.devcontainer-wp/ または .devcontainer-node/ のテンプレを読み込み、
案件固有の値で置換した .devcontainer/ を生成する。

設計方針:
- テンプレ実体は触らない（書き換えない）
- 置換は明示的な「マーカー」ベース。マーカーが見つからない場合はエラー終了して
  テンプレが期待形と異なることを通知する（サイレントに崩れない）
- 出力先が既存の場合は --force でのみ上書き
- 生成結果は .devcontainer/.wp-docker-setup.json（マニフェスト）に記録する。
  wp-docker-update スキルが「テンプレ更新で変わっただけ」と「利用者が手で直した」を
  区別するためにファイルごとの sha256 を残す
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Callable

MANIFEST_NAME = ".wp-docker-setup.json"


# ---------- 置換マーカー定義 ----------
# 各テンプレファイルに対して、(検出パターン, 置換関数 or 文字列) のリストを定義する。
# 検出パターンは「テンプレが期待形と一致しているか」を確認するアサーション役も兼ねる。

class TemplateMismatch(Exception):
    pass


def _normalize_lf(content: str) -> str:
    return content.replace("\r\n", "\n").replace("\r", "\n")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_skill_version() -> str | None:
    """自分が属するスキルの SKILL.md から version を読む（単一の情報源にする）。"""
    skill_md = Path(__file__).resolve().parent.parent / "SKILL.md"
    if not skill_md.is_file():
        return None
    text = skill_md.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^version:\s*[\"']?([^\"'\s]+)[\"']?\s*$", text, flags=re.MULTILINE)
    return m.group(1) if m else None


def _extract_table_prefix(content: str) -> str | None:
    m = re.search(r"^\s*\$table_prefix\s*=\s*'([^']*)';", content, flags=re.MULTILINE)
    return m.group(1) if m else None


def _set_php_define(content: str, name: str, value: str) -> str:
    pattern = re.compile(
        rf"define\(\s*'{re.escape(name)}'\s*,\s*'[^']*'\s*\);"
    )
    replacement = f"define( '{name}', '{value}' );"
    if pattern.search(content):
        return pattern.sub(replacement, content, count=1)

    # DB_* は DB_COLLATE の後ろに追加、それ以外は stop editing コメント前に追加
    if name in {"DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"}:
        anchor = "define( 'DB_COLLATE', '' );"
        if anchor in content:
            return content.replace(anchor, anchor + "\n" + replacement)

    stop_anchor = "/* That's all, stop editing! Happy publishing. */"
    if stop_anchor in content:
        return content.replace(stop_anchor, replacement + "\n\n" + stop_anchor)

    return content + "\n" + replacement + "\n"


def _set_table_prefix(content: str, table_prefix: str) -> str:
    pattern = re.compile(r"^\s*\$table_prefix\s*=\s*'[^']*';", flags=re.MULTILINE)
    replacement = f"$table_prefix = '{table_prefix}';"
    if pattern.search(content):
        return pattern.sub(replacement, content, count=1)

    wp_debug_anchor = "define( 'WP_DEBUG', false );"
    if wp_debug_anchor in content:
        return content.replace(wp_debug_anchor, replacement + "\n\n" + wp_debug_anchor)

    return content + "\n" + replacement + "\n"


def _extract_compose_wp_settings(compose_path: Path) -> dict[str, str]:
    defaults = {
        "WORDPRESS_DB_NAME": "database",
        "WORDPRESS_DB_USER": "user",
        "WORDPRESS_DB_PASSWORD": "p@ssw0rd",
        "WORDPRESS_DB_HOST": "sql",
        "WORDPRESS_TABLE_PREFIX": "wp_",
    }

    if not compose_path.is_file():
        return defaults

    text = compose_path.read_text(encoding="utf-8", errors="replace")
    for key in defaults.keys():
        m = re.search(rf"^\s*{re.escape(key)}\s*:\s*(.+?)\s*(?:#.*)?$", text, flags=re.MULTILINE)
        if m:
            defaults[key] = m.group(1).strip().strip("\"'")

    return defaults


def _minimal_wp_config(*, db_name: str, db_user: str, db_password: str, db_host: str, table_prefix: str) -> str:
    return (
        "<?php\n"
        "/**\n"
        " * WordPress base configuration for local Docker environment.\n"
        " */\n\n"
        "// ** Database settings ** //\n"
        f"define( 'DB_NAME', '{db_name}' );\n"
        f"define( 'DB_USER', '{db_user}' );\n"
        f"define( 'DB_PASSWORD', '{db_password}' );\n"
        f"define( 'DB_HOST', '{db_host}' );\n"
        "define( 'DB_CHARSET', 'utf8' );\n"
        "define( 'DB_COLLATE', '' );\n"
        "define( 'WPLANG', 'ja' );\n\n"
        "/**#@+\n"
        " * Authentication unique keys and salts.\n"
        " */\n"
        "define( 'AUTH_KEY',         'local-auth-key-change-me' );\n"
        "define( 'SECURE_AUTH_KEY',  'local-secure-auth-key-change-me' );\n"
        "define( 'LOGGED_IN_KEY',    'local-logged-in-key-change-me' );\n"
        "define( 'NONCE_KEY',        'local-nonce-key-change-me' );\n"
        "define( 'AUTH_SALT',        'local-auth-salt-change-me' );\n"
        "define( 'SECURE_AUTH_SALT', 'local-secure-auth-salt-change-me' );\n"
        "define( 'LOGGED_IN_SALT',   'local-logged-in-salt-change-me' );\n"
        "define( 'NONCE_SALT',       'local-nonce-salt-change-me' );\n"
        "/**#@-*/\n\n"
        f"$table_prefix = '{table_prefix}';\n\n"
        "define( 'WP_DEBUG', false );\n\n"
        "/* That's all, stop editing! Happy publishing. */\n"
        "if ( ! defined( 'ABSPATH' ) ) {\n"
        "\tdefine( 'ABSPATH', __DIR__ . '/' );\n"
        "}\n\n"
        "require_once ABSPATH . 'wp-settings.php';\n"
    )


def _sync_wp_config(
    *,
    project_root: Path,
    wp_root: str,
    wp_table_prefix: str,
    db_name: str,
    db_user: str,
    db_password: str,
    db_host: str,
    overwrite_existing: bool,
) -> list[str]:
    warnings: list[str] = []
    wp_root_dir = project_root / wp_root
    wp_root_dir.mkdir(parents=True, exist_ok=True)

    wp_config_path = wp_root_dir / "wp-config.php"

    if wp_config_path.exists() and wp_config_path.is_dir():
        raise TemplateMismatch(
            f"wp-config.php がディレクトリになっています。内容を確認して手動で対処してください: {wp_config_path}"
        )

    if wp_config_path.exists():
        content = wp_config_path.read_text(encoding="utf-8", errors="replace")
        existing_prefix = _extract_table_prefix(content)
        if existing_prefix is not None and existing_prefix != wp_table_prefix:
            warnings.append(
                f"既存wp-config.phpの$table_prefixは '{existing_prefix}' ですが、ヒアリング値は '{wp_table_prefix}' です。"
            )
        if not overwrite_existing:
            warnings.append(
                "既存wp-config.phpを検出したため、DB設定と$table_prefixは変更していません。"
            )
            return warnings
    else:
        sample_path = wp_root_dir / "wp-config-sample.php"
        if sample_path.is_file():
            content = sample_path.read_text(encoding="utf-8", errors="replace")
        else:
            content = _minimal_wp_config(
                db_name=db_name,
                db_user=db_user,
                db_password=db_password,
                db_host=db_host,
                table_prefix=wp_table_prefix,
            )

    content = _set_php_define(content, "DB_NAME", db_name)
    content = _set_php_define(content, "DB_USER", db_user)
    content = _set_php_define(content, "DB_PASSWORD", db_password)
    content = _set_php_define(content, "DB_HOST", db_host)
    content = _set_php_define(content, "WPLANG", "ja")
    content = _set_table_prefix(content, wp_table_prefix)

    wp_config_path.write_text(content, encoding="utf-8", newline="")

    return warnings


def _replace_or_fail(content: str, old: str, new: str, file_label: str) -> str:
    """old が必ず1回以上含まれることを確認し、置換する。"""
    if old not in content:
        raise TemplateMismatch(
            f"[{file_label}] 期待する文字列が見つかりません: {old!r}\n"
            "テンプレが更新された可能性があります。"
            "scripts/install_devcontainer.py の置換ルールを更新してください。"
        )
    return content.replace(old, new)


def _replace_optional(content: str, old: str, new: str) -> str:
    """old が見つからなくてもエラーにしない。"""
    return content.replace(old, new) if old in content else content


# ---------- WP テンプレ用 置換関数群 ----------

def transform_wp_devcontainer_json(
    content: str,
    *,
    project_name: str,
) -> str:
    return _replace_or_fail(
        content,
        '"name": "wp-template"',
        f'"name": "{project_name}"',
        "devcontainer.json",
    )


def transform_wp_docker_compose(
    content: str,
    *,
    wp_root: str,
    wp_content: str,
    wp_table_prefix: str,
    mysql_version: str | None,
) -> str:
    # wordpress → wp_root
    if wp_root != "wordpress":
        # 順序が重要: 長い方から先に置換することで誤マッチを避ける
        for old, new in [
            ("/var/www/html/wordpress", f"/var/www/html/{wp_root}"),
            ("../wordpress/wp-config.php", f"../{wp_root}/wp-config.php"),
            ("../wordpress/wp-content", f"../{wp_root}/wp-content"),
            ("wp_core:/var/www/html/wordpress", f"wp_core:/var/www/html/{wp_root}"),
        ]:
            content = _replace_optional(content, old, new)

    # wp-content フォルダ名（line 11付近のみ。他のwp-contentは変えない）
    if wp_content != "wp-content":
        # docker-compose.yml の x-wp-content アンカー定義行のみを置換
        old_line = (
            f"x-wp-content: &wp_content ../{wp_root}/wp-content:"
            f"/var/www/html/{wp_root}/wp-content"
        )
        new_line = (
            f"x-wp-content: &wp_content ../{wp_root}/{wp_content}:"
            f"/var/www/html/{wp_root}/wp-content"
        )
        content = _replace_or_fail(
            content, old_line, new_line, "docker-compose.yml (x-wp-content)"
        )

    # wp-config.php のテーブル接頭子
    # 旧テンプレは docker-compose.yml 内の sed で同期、現行テンプレは
    # scripts/init-wp-config.sh 側で同期する。
    uses_init_script = "init-wp-config.sh" in content
    if not uses_init_script:
        # 1) x-copy-wp 内の sed に table_prefix 置換を追加
        # 既にテンプレ側で対応済みなら何もしない。
        has_table_prefix_sed = (
            "sed -i" in content
            and "wp-config.php" in content
            and "table_prefix" in content
            and "WORDPRESS_TABLE_PREFIX" in content
        )
        if not has_table_prefix_sed:
            sed_anchor = (
                f"    sed -i \\\"s/localhost/${{WORDPRESS_DB_HOST}}/\\\" /var/www/html/{wp_root}/wp-config.php &&\n"
                f"    sed -i \\\"/define( 'DB_COLLATE', '' );/a define( 'WPLANG', 'ja' );\\\" /var/www/html/{wp_root}/wp-config.php;"
            )
            sed_insert = (
                f"    sed -i \\\"s/localhost/${{WORDPRESS_DB_HOST}}/\\\" /var/www/html/{wp_root}/wp-config.php &&\n"
                f"    sed -i \\\"s/\\\\$table_prefix = 'wp_';/\\\\$table_prefix = '${{WORDPRESS_TABLE_PREFIX}}';/\\\" /var/www/html/{wp_root}/wp-config.php &&\n"
                f"    sed -i \\\"/define( 'DB_COLLATE', '' );/a define( 'WPLANG', 'ja' );\\\" /var/www/html/{wp_root}/wp-config.php;"
            )
            content = _replace_or_fail(
                content,
                sed_anchor,
                sed_insert,
                "docker-compose.yml (wp-config table_prefix sed)",
            )

    # 2) php サービス環境変数に WORDPRESS_TABLE_PREFIX を追加/更新
    env_anchor = "      WORDPRESS_DB_HOST: sql # wp-config.phpのDB_HOSTに書く値"
    if "WORDPRESS_TABLE_PREFIX:" in content:
        content = re.sub(
            r"^\s*WORDPRESS_TABLE_PREFIX\s*:\s*.*$",
            f"      WORDPRESS_TABLE_PREFIX: {wp_table_prefix} # wp-config.phpの$table_prefixに書く値",
            content,
            flags=re.MULTILINE,
        )
    else:
        content = _replace_or_fail(
            content,
            env_anchor,
            env_anchor
            + f"\n      WORDPRESS_TABLE_PREFIX: {wp_table_prefix} # wp-config.phpの$table_prefixに書く値",
            "docker-compose.yml (php environment table_prefix)",
        )

    # MySQL バージョン
    if mysql_version:
        # 既存の "image: mysql:9.6.0" のような行を置換
        # まず現在のバージョンをテンプレから検出

        m = re.search(r"image:\s*mysql:(\S+)", content)
        if m and m.group(1) != mysql_version:
            content = content.replace(
                f"image: mysql:{m.group(1)}",
                f"image: mysql:{mysql_version}",
            )

    return content


def transform_wp_dockerfile_php(
    content: str,
    *,
    php_version: str | None,
    wp_version: str | None,
) -> str:
    if php_version:
        import re

        m = re.search(r"FROM\s+php:(\S+?)-fpm", content)
        if not m:
            raise TemplateMismatch(
                "[Dockerfile.php] FROM php:X.Y.Z-fpm 形式の行が見つかりません"
            )
        if m.group(1) != php_version:
            content = content.replace(
                f"FROM php:{m.group(1)}-fpm", f"FROM php:{php_version}-fpm"
            )

    if wp_version:
        import re

        m = re.search(r"ENV\s+WORDPRESS_VERSION=(\S+)", content)
        if not m:
            raise TemplateMismatch(
                "[Dockerfile.php] ENV WORDPRESS_VERSION=... 行が見つかりません"
            )
        if m.group(1) != wp_version:
            content = content.replace(
                f"ENV WORDPRESS_VERSION={m.group(1)}",
                f"ENV WORDPRESS_VERSION={wp_version}",
            )

    return content


# ---------- Node テンプレ用 置換関数群 ----------

def transform_node_devcontainer_json(
    content: str,
    *,
    project_name: str,
) -> str:
    return _replace_or_fail(
        content,
        '"name": "node-template"',
        f'"name": "{project_name}"',
        "devcontainer.json",
    )


def transform_node_dockerfile_frontend(
    content: str,
    *,
    node_version: str | None,
) -> str:
    if not node_version:
        return content

    import re

    m = re.search(r"FROM\s+node:(\S+)", content)
    if not m:
        raise TemplateMismatch(
            "[Dockerfile.frontend] FROM node:X.Y.Z 形式の行が見つかりません"
        )
    if m.group(1) != node_version:
        content = content.replace(
            f"FROM node:{m.group(1)}", f"FROM node:{node_version}"
        )
    return content


# ---------- ファイル種別 → 変換関数のディスパッチ ----------

def _process_wp_file(
    relpath: str,
    content: str,
    *,
    project_name: str,
    wp_root: str,
    wp_content: str,
    wp_table_prefix: str,
    mysql_version: str | None,
    php_version: str | None,
    wp_version: str | None,
) -> str:
    if relpath == "devcontainer.json":
        return transform_wp_devcontainer_json(content, project_name=project_name)
    if relpath == "docker-compose.yml":
        return transform_wp_docker_compose(
            content,
            wp_root=wp_root,
            wp_content=wp_content,
            wp_table_prefix=wp_table_prefix,
            mysql_version=mysql_version,
        )
    if relpath == "Dockerfile.php":
        return transform_wp_dockerfile_php(
            content, php_version=php_version, wp_version=wp_version
        )
    if relpath == "README.md":
        return content.replace("/wordpress/wp-admin/", f"/{wp_root}/wp-admin/")
    if relpath == "scripts/init-wp-config.sh":
        return content.replace("{{WP_ROOT}}", wp_root)
    # それ以外（httpd.conf, nginx.conf, msmtprc, .gitignore, scripts/init-certs.sh, Dockerfile.node）
    # は変更不要
    return content


def _process_node_file(
    relpath: str,
    content: str,
    *,
    project_name: str,
    node_version: str | None,
) -> str:
    if relpath == "devcontainer.json":
        return transform_node_devcontainer_json(content, project_name=project_name)
    if relpath == "Dockerfile.frontend":
        return transform_node_dockerfile_frontend(content, node_version=node_version)
    return content


# ---------- ディレクトリコピー本体 ----------

TEXT_EXTENSIONS = {".json", ".yml", ".yaml", ".conf", ".sh", ".gitignore", ".node", ".md"}


def _is_text_file(path: Path) -> bool:
    """テキストとして処理するか判定。Dockerfile* もテキスト扱い。"""
    if path.name.startswith("Dockerfile"):
        return True
    if path.name == "msmtprc":
        return True
    return path.suffix.lower() in TEXT_EXTENSIONS


def _resolve_template_dir(project_root: Path, template_type: str) -> Path:
    """テンプレディレクトリの探索順を定義する。"""
    template_name = f".devcontainer-{template_type}"
    candidates = [
        project_root / ".claude" / "skills" / "wp-docker-setup" / "templates" / template_name,
        project_root / template_name,
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate

    candidate_list = "\n".join(f"- {c}" for c in candidates)
    raise FileNotFoundError(
        "テンプレが見つかりません。以下を確認してください:\n"
        f"{candidate_list}"
    )


def ensure_shell_lf_gitattributes(project_root: Path) -> str:
    """.gitattributes に .sh の LF 固定ルールを追加する。

    wp-docker-update スキルからも呼ばれる公開 API。改名する場合は
    wp-docker-update/scripts/update_devcontainer.py の参照も直すこと。
    """
    path = project_root / ".gitattributes"
    required = "*.sh text eol=lf"

    if path.exists():
        content = path.read_text(encoding="utf-8", errors="replace")
        normalized = _normalize_lf(content)
        lines = [line.strip() for line in normalized.split("\n")]
        if required in lines:
            return str(path)

        if normalized and not normalized.endswith("\n"):
            normalized += "\n"
        normalized += required + "\n"
        path.write_text(normalized, encoding="utf-8", newline="\n")
        return str(path)

    path.write_text(required + "\n", encoding="utf-8", newline="\n")
    return str(path)


def render_template_files(
    *,
    template_type: str,
    template_dir: Path,
    project_name: str,
    wp_root: str = "wordpress",
    wp_content: str = "wp-content",
    wp_table_prefix: str = "wp_",
    mysql_version: str | None = None,
    php_version: str | None = None,
    wp_version: str | None = None,
    node_version: str | None = None,
) -> dict[str, bytes]:
    """テンプレ展開の結果を relpath -> 書き出すバイト列 で返す。

    ディスクには一切触らない純粋関数。install() と wp-docker-update スキルの両方が
    これを呼ぶことで「生成される中身」の定義を1箇所に保つ。
    """
    if template_type == "wp":
        process: Callable[[str, str], str] = lambda relpath, content: _process_wp_file(
            relpath,
            content,
            project_name=project_name,
            wp_root=wp_root,
            wp_content=wp_content,
            wp_table_prefix=wp_table_prefix,
            mysql_version=mysql_version,
            php_version=php_version,
            wp_version=wp_version,
        )
    elif template_type == "node":
        process = lambda relpath, content: _process_node_file(
            relpath,
            content,
            project_name=project_name,
            node_version=node_version,
        )
    else:
        raise ValueError(f"unknown template type: {template_type}")

    rendered: dict[str, bytes] = {}
    for path in sorted(template_dir.rglob("*")):
        if path.is_dir():
            continue
        relpath = path.relative_to(template_dir).as_posix()
        if _is_text_file(path):
            content = path.read_text(encoding="utf-8", errors="replace")
            transformed = process(relpath, content)
            if path.suffix.lower() == ".sh":
                transformed = _normalize_lf(transformed)
            rendered[relpath] = transformed.encode("utf-8")
        else:
            rendered[relpath] = path.read_bytes()

    return rendered


def resolve_effective_params(
    *, template_type: str, params: dict, rendered: dict[str, bytes]
) -> dict:
    """生成物から実際に使われたバージョンを読み戻し、params を実効値で確定する。

    --php-version 等を省略するとテンプレの既定値が使われるが、それを params に None のまま
    記録すると「バージョン指定なし＝テンプレの最新に追従してよい」と誤読される。実際には
    その案件は生成時点の PHP / MySQL で動いており、勝手に上げると（特に MySQL のメジャー更新は
    既存データボリュームと非互換で）環境が壊れる。生成時点の実効値を記録して pin する。
    """
    resolved = dict(params)

    def _rendered_text(relpath: str) -> str:
        data = rendered.get(relpath)
        return data.decode("utf-8", errors="replace") if data is not None else ""

    if template_type == "wp":
        dockerfile = _rendered_text("Dockerfile.php")
        m = re.search(r"^FROM\s+php:(\S+?)-fpm", dockerfile, flags=re.MULTILINE)
        if m:
            resolved["php_version"] = m.group(1)
        m = re.search(r"^ENV\s+WORDPRESS_VERSION=(\S+)", dockerfile, flags=re.MULTILINE)
        if m:
            resolved["wp_version"] = m.group(1)

        m = re.search(r"image:\s*mysql:(\S+)", _rendered_text("docker-compose.yml"))
        if m:
            resolved["mysql_version"] = m.group(1)
    else:
        m = re.search(
            r"^FROM\s+node:(\S+)", _rendered_text("Dockerfile.frontend"), flags=re.MULTILINE
        )
        if m:
            resolved["node_version"] = m.group(1)

    return resolved


def build_manifest(
    *,
    template_type: str,
    params: dict,
    rendered: dict[str, bytes],
    skill_version: str | None = None,
) -> dict:
    """生成結果の素性を記録するマニフェスト。

    files の sha256 は「このスキルが生成した内容」の基準点。次回更新時に実物と
    突き合わせることで、利用者の手編集をテンプレ更新と誤認して潰すのを防ぐ。
    再実行で内容が変わらないよう、生成時刻のような非決定な値は入れない。
    """
    return {
        "skill": "wp-docker-setup",
        "skill_version": skill_version if skill_version is not None else read_skill_version(),
        "template_type": template_type,
        "params": params,
        "files": {relpath: sha256_bytes(data) for relpath, data in sorted(rendered.items())},
    }


def write_manifest(dest: Path, manifest: dict) -> None:
    text = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    (dest / MANIFEST_NAME).write_text(text, encoding="utf-8", newline="\n")


def install(
    *,
    template_type: str,
    project_root: Path,
    output_dir: str,
    project_name: str,
    wp_root: str = "wordpress",
    wp_content: str = "wp-content",
    wp_table_prefix: str = "wp_",
    mysql_version: str | None = None,
    php_version: str | None = None,
    wp_version: str | None = None,
    node_version: str | None = None,
    force: bool = False,
) -> dict:
    if template_type not in {"wp", "node"}:
        raise ValueError(f"unknown template type: {template_type}")

    warnings: list[str] = []

    src = _resolve_template_dir(project_root, template_type)

    params = {
        "project_name": project_name,
        "wp_root": wp_root,
        "wp_content": wp_content,
        "wp_table_prefix": wp_table_prefix,
        "mysql_version": mysql_version,
        "php_version": php_version,
        "wp_version": wp_version,
        "node_version": node_version,
    }

    rendered = render_template_files(
        template_type=template_type,
        template_dir=src,
        **params,
    )

    dest = project_root / output_dir
    if dest.exists():
        if not force:
            raise FileExistsError(
                f"出力先が既に存在します: {dest}\n"
                "上書きしてよければ --force を付けて再実行してください。\n"
                "既存環境に新機能だけ足したい場合は wp-docker-update スキル"
                "（/wp-docker-update）を使ってください。"
            )
        shutil.rmtree(dest)

    dest.mkdir(parents=True)

    # テンプレ側の空ディレクトリも再現する
    for path in sorted(src.rglob("*")):
        if path.is_dir():
            (dest / path.relative_to(src).as_posix()).mkdir(parents=True, exist_ok=True)

    written: list[str] = []
    for relpath, data in rendered.items():
        out_path = dest / relpath
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(data)
        written.append(relpath)

    write_manifest(
        dest,
        build_manifest(
            template_type=template_type,
            params=resolve_effective_params(
                template_type=template_type, params=params, rendered=rendered
            ),
            rendered=rendered,
        ),
    )

    if template_type == "wp":
        compose_settings = _extract_compose_wp_settings(dest / "docker-compose.yml")
        warnings.extend(
            _sync_wp_config(
                project_root=project_root,
                wp_root=wp_root,
                wp_table_prefix=compose_settings["WORDPRESS_TABLE_PREFIX"],
                db_name=compose_settings["WORDPRESS_DB_NAME"],
                db_user=compose_settings["WORDPRESS_DB_USER"],
                db_password=compose_settings["WORDPRESS_DB_PASSWORD"],
                db_host=compose_settings["WORDPRESS_DB_HOST"],
                overwrite_existing=False,
            )
        )

    gitattributes_path = ensure_shell_lf_gitattributes(project_root)

    return {
        "template": template_type,
        "skill_version": read_skill_version(),
        "source": str(src),
        "output": str(dest),
        "files": written,
        "manifest": str(dest / MANIFEST_NAME),
        "updated_gitattributes": gitattributes_path,
        "warnings": warnings,
    }


# ---------- CLI ----------

def main() -> int:
    p = argparse.ArgumentParser(
        description=".devcontainer-wp/.devcontainer-node テンプレを案件用に展開"
    )
    p.add_argument("--type", required=True, choices=["wp", "node"], help="テンプレ種別")
    p.add_argument(
        "--project-root",
        required=True,
        help="案件リポジトリのルート絶対パス",
    )
    p.add_argument("--name", required=True, help="案件名（devcontainer.jsonのname値）")
    p.add_argument("--output", default=".devcontainer", help="出力先ディレクトリ名")
    p.add_argument("--force", action="store_true", help="出力先が既存でも上書き")
    p.add_argument(
        "--repair-wp-config-only",
        action="store_true",
        help=".devcontainer再生成は行わず、wp-config.php のみを compose の値で修正",
    )

    # WP用
    p.add_argument("--wp-root", default="wordpress")
    p.add_argument("--wp-content", default="wp-content")
    p.add_argument("--wp-table-prefix", default=None)
    p.add_argument("--mysql-version", default=None)
    p.add_argument("--php-version", default=None)
    p.add_argument("--wp-version", default=None)

    # Node用
    p.add_argument("--node-version", default=None)

    args = p.parse_args()

    if args.wp_table_prefix and not re.fullmatch(r"[A-Za-z0-9_]+", args.wp_table_prefix):
        print(
            "ERROR: --wp-table-prefix は英数字とアンダースコアのみ使用できます。",
            file=sys.stderr,
        )
        return 1

    project_root = Path(args.project_root)

    if args.repair_wp_config_only:
        if args.type != "wp":
            print("ERROR: --repair-wp-config-only は --type wp のときのみ使用できます。", file=sys.stderr)
            return 1

        compose_path = project_root / args.output / "docker-compose.yml"
        if not compose_path.is_file():
            print(
                f"ERROR: composeファイルが見つかりません: {compose_path}",
                file=sys.stderr,
            )
            return 1

        compose_settings = _extract_compose_wp_settings(compose_path)
        desired_prefix = args.wp_table_prefix or compose_settings["WORDPRESS_TABLE_PREFIX"]

        warnings: list[str] = []
        if args.wp_table_prefix and args.wp_table_prefix != compose_settings["WORDPRESS_TABLE_PREFIX"]:
            warnings.append(
                "ヒアリングされた接頭子とcompose内のWORDPRESS_TABLE_PREFIXが異なります: "
                f"'{compose_settings['WORDPRESS_TABLE_PREFIX']}' -> '{args.wp_table_prefix}'"
            )

        warnings.extend(
            _sync_wp_config(
                project_root=project_root,
                wp_root=args.wp_root,
                wp_table_prefix=desired_prefix,
                db_name=compose_settings["WORDPRESS_DB_NAME"],
                db_user=compose_settings["WORDPRESS_DB_USER"],
                db_password=compose_settings["WORDPRESS_DB_PASSWORD"],
                db_host=compose_settings["WORDPRESS_DB_HOST"],
                overwrite_existing=True,
            )
        )

        print(
            json.dumps(
                {
                    "template": "wp",
                    "mode": "repair-wp-config-only",
                    "compose": str(compose_path),
                    "wp_config": str(project_root / args.wp_root / "wp-config.php"),
                    "warnings": warnings,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    try:
        result = install(
            template_type=args.type,
            project_root=project_root,
            output_dir=args.output,
            project_name=args.name,
            wp_root=args.wp_root,
            wp_content=args.wp_content,
            wp_table_prefix=args.wp_table_prefix or "wp_",
            mysql_version=args.mysql_version,
            php_version=args.php_version,
            wp_version=args.wp_version,
            node_version=args.node_version,
            force=args.force,
        )
    except (TemplateMismatch, FileNotFoundError, FileExistsError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
